// server.js                                       require('dotenv').config();
const express = require('express');
const BusboyPkg = require('busboy');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');        const { S3Client } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

const app = express();

// ----- Konfig -----
const MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// S3 / R2 client
const s3 = new S3Client({
  region: process.env.R2_REGION || 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// Map of uploadId -> EventEmitter for SSE progress
const uploads = new Map();

// Normalize public URL helper
function getNormalizedPublicUrl() {
  let publicUrl = (process.env.R2_PUBLIC_URL || '').trim();
  if (!publicUrl) return '';
  publicUrl = publicUrl.replace(/\/+$/g, '');
  if (!/^https?:\/\//i.test(publicUrl)) {
    publicUrl = 'https://' + publicUrl;
  }                                                  return publicUrl;
}
const R2_PUBLIC_URL = getNormalizedPublicUrl();

// format bytes to MB string like "20mo"
function formatMB(bytes) {
  return `${Math.round(bytes / 1024 / 1024)}mo`;
}
                                                   // Robust busboy factory                           function getBusboyFactory() {
  if (!BusboyPkg) throw new Error('busboy not installed');
  if (typeof BusboyPkg === 'function') return BusboyPkg;
  if (BusboyPkg && typeof BusboyPkg.Busboy === 'function') return BusboyPkg.Busboy;                     return BusboyPkg;
}

// SSE endpoint: client connects to /progress/:uploadId
app.get('/progress/:uploadId', (req, res) => {
  const { uploadId } = req.params;
  if (!uploadId) return res.status(400).end('Missing uploadId');

  // headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // find/create emitter
  let emitter = uploads.get(uploadId);
  if (!emitter) {
    // create placeholder emitter so server will be able to emit even if client connects first/second
    emitter = new EventEmitter();
    emitter.setMaxListeners(0);
    uploads.set(uploadId, emitter);
  }

  // send a ping so client knows we're connected
  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true, uploadId })}\n\n`);
                                                     const onProgress = (data) => {
    res.write(`event: progress\ndata: ${JSON.stringify(data)}\n\n`);
  };                                                 const onDone = (data) => {
    res.write(`event: done\ndata: ${JSON.stringify(data)}\n\n`);                                          // keep connection open a short time then close
    setTimeout(() => {                                   try { res.end(); } catch (e) {}
    }, 500);                                         };                                                 const onError = (data) => {
    res.write(`event: error\ndata: ${JSON.stringify(data)}\n\n`);                                       };
                                                     emitter.on('progress', onProgress);
  emitter.on('done', onDone);                        emitter.on('error', onError);                    
  // Cleanup when client disconnects                 req.on('close', () => {
    emitter.removeListener('progress', onProgress);    emitter.removeListener('done', onDone);
    emitter.removeListener('error', onError);          // if no listeners and upload finished, we'll cleanup in upload flow; otherwise keep emitter in map
  });                                              });
                                                   // ---- Upload endpoint ----                       // Accept header 'x-upload-id' to tie upload to SSE channel.                                          // Also accept 'x-file-size' (client-provided file size) for better receiving progress.               app.post('/upload', (req, res) => {                  const contentLength = parseInt(req.headers['content-length'] || '0', 10);                             const clientFileSizeHeader = parseInt(req.headers['x-file-size'] || '0', 10);
  const declaredTotal = clientFileSizeHeader || contentLength || 0;
  const uploadIdHeader = (req.headers['x-upload-id'] || '').toString();                               
  const Busboy = getBusboyFactory();                 let busboy;
  try {                                                busboy = new Busboy({ headers: req.headers, limits: { fileSize: MAX_FILE_BYTES } });                } catch (err) {                                      busboy = Busboy({ headers: req.headers, limits: { fileSize: MAX_FILE_BYTES } });
  }

  // Ensure emitter exists for this uploadId
  let emitter = null;
  if (uploadIdHeader) {
    emitter = uploads.get(uploadIdHeader);
    if (!emitter) {
      emitter = new EventEmitter();
      emitter.setMaxListeners(0);
      uploads.set(uploadIdHeader, emitter);
    }
  }

  let responded = false;
  let fileHandled = false;

  busboy.on('file', (fieldname, fileStream, third, fourth, fifth) => {
    // detect signature variations
    let filename = 'file';
    let encoding = '';                                 let mimetype = 'application/octet-stream';
    if (typeof third === 'string') {
      filename = third || filename;
      encoding = fourth || encoding;
      mimetype = fifth || mimetype;
    } else if (third && typeof third === 'object') {                                                        const info = third;
      filename = info.filename || info.fileName || filename;
      encoding = info.encoding || encoding;
      mimetype = info.mimeType || info.mime || info.mimetype || mimetype;
    }
    filename = path.basename(String(filename || 'file'));
    if (!filename) {
      fileStream.resume();
      return;
    }

    fileHandled = true;
    const safeName = `${Date.now()}-${filename.replace(/\s+/g, '_')}`;
    const tempPath = path.join(uploadDir, safeName);
    const writeStream = fs.createWriteStream(tempPath);

    let received = 0;
    const totalForProgress = declaredTotal || (contentLength ? contentLength : 0);

    console.log(`Start receiving ${filename} -> temp: ${tempPath}`);

    // progress during receiving (client -> server)    fileStream.on('data', (chunk) => {                   received += chunk.length;
      if (emitter) {
        const percent = totalForProgress ? Math.min(100, Math.floor((received / totalForProgress) * 100)) : null;
        emitter.emit('progress', {
          phase: 'receiving',
          filename,
          loaded: received,                                  total: totalForProgress || null,
          percent
        });                                              }                                                });
                                                       fileStream.on('limit', () => {                       console.warn(`${filename} exceeded limit ${formatMB(MAX_FILE_BYTES)} - aborting`);                    try { fileStream.unpipe(); } catch (e) {}          try { writeStream.end(); } catch (e) {}
      try { fs.unlinkSync(tempPath); } catch (e) {}      if (emitter) emitter.emit('error', { message: 'File too large (limit 5 GB)' });                       if (!responded) {
        responded = true;                                  res.status(413).json({ error: 'File too large. Limit is 5 GB.' });
      }                                                });
                                                       fileStream.on('error', (err) => {
      console.error(`Read stream error for ${filename}:`, err);                                             try { writeStream.end(); } catch (e) {}
      try { fs.unlinkSync(tempPath); } catch (e) {}      if (emitter) emitter.emit('error', { message: err.message });                                         if (!responded) {
        responded = true;
        res.status(500).json({ error: 'File stream error', details: err.message });
      }
    });

    // pipe to disk
    fileStream.pipe(writeStream);

    writeStream.on('error', (err) => {
      console.error(`Write stream error for ${tempPath}:`, err);
      try { fileStream.unpipe(); } catch (e) {}
      try { fs.unlinkSync(tempPath); } catch (e) {}      if (emitter) emitter.emit('error', { message: err.message });
      if (!responded) {                                    responded = true;                                  res.status(500).json({ error: 'Disk write error', details: err.message });                          }                                                });
                                                       fileStream.on('end', async () => {
      writeStream.end();                                 console.log(`${filename} fully received (${formatMB(received)}) — starting upload to R2`);                                                               // Get actual file size from disk
      let fileSizeOnDisk = received;                     try {
        const st = fs.statSync(tempPath);                  fileSizeOnDisk = st.size;
      } catch (e) { /* ignore */ }
                                                         const key = `${Date.now()}-${filename.replace(/\s+/g, '_')}`;                                         const fileReadStream = fs.createReadStream(tempPath);                                           
      try {
        const parallelUploads3 = new Upload({
          client: s3,
          params: {
            Bucket: process.env.R2_BUCKET,
            Key: key,
            Body: fileReadStream,
            ContentType: mimetype || 'application/octet-stream',
          },
          queueSize: 4,
          partSize: 10 * 1024 * 1024, // 10 MB               leavePartsOnError: false,
        });
                                                           parallelUploads3.on('httpUploadProgress', (progress) => {
          const loaded = progress.loaded || 0;
          const total = progress.total || fileSizeOnDisk || 0;
          const percent = total ? Math.min(100, Math.floor((loaded / total) * 100)) : null;
          console.log(`S3 upload ${filename} ${formatMB(loaded)}/${formatMB(total)} ${percent || ''}%`);
          if (emitter) {
            emitter.emit('progress', {
              phase: 'uploading',
              filename,
              loaded,
              total,
              percent
            });
          }
        });

        await parallelUploads3.done();

        // delete temp file
        try { fs.unlinkSync(tempPath); } catch (e) { console.warn('Could not delete temp file', e); }

        const fileUrl = R2_PUBLIC_URL ? `${R2_PUBLIC_URL}/${key}` : `/${key}`;

        if (emitter) {
          emitter.emit('done', { filename, url: fileUrl, key });
          // cleanup emitter after short timeout
          setTimeout(() => {
            uploads.delete(uploadIdHeader);
            try { emitter.removeAllListeners(); } catch (e) {}
          }, 2000);
        } else {
          // no emitter: just proceed
        }

        if (!responded) {
          responded = true;
          res.json({ message: 'Upload successful!', url: fileUrl, key });
        }
      } catch (err) {
        console.error('Upload to R2 failed', err);
        try { fs.unlinkSync(tempPath); } catch (e) {}
        if (emitter) emitter.emit('error', { message: err.message });
        if (!responded) {
          responded = true;
          res.status(500).json({ error: 'Upload to R2 failed', details: err.message });
        }
      }
    });
  });

  busboy.on('field', (name, val) => {
    // optional fields
  });

  busboy.on('finish', () => {
    if (!fileHandled && !responded) {
      responded = true;
      res.status(400).json({ error: 'No file uploaded' });
    }
  });

  busboy.on('error', (err) => {
    console.error('Busboy error', err);
    if (emitter) emitter.emit('error', { message: err.message });
    if (!responded) {
      responded = true;
      res.status(500).json({ error: 'Parse error', details: err.message });
    }
  });

  req.pipe(busboy);
});

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Max upload size set to 5 GB.');
});
