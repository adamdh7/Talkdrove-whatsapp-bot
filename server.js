// server.js
require('dotenv').config();
const express = require('express');
const BusboyPkg = require('busboy');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { S3Client } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const cors = require('cors');

const app = express();

const PORT = process.env.PORT || 3000;
const MAX_FILE_BYTES = parseInt(process.env.CHUNK_MAX_SIZE || String(5 * 1024 * 1024 * 1024), 10); // default 5 GB
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const s3 = new S3Client({
  region: process.env.R2_REGION || 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
  },
});

const uploads = new Map(); // uploadId -> EventEmitter

function getNormalizedPublicUrl() {
  let publicUrl = (process.env.R2_PUBLIC_URL || '').trim();
  if (!publicUrl) return '';
  publicUrl = publicUrl.replace(/\/+/g, '/').replace(/\/+$/g, '');
  if (!/^https?:\/\//i.test(publicUrl)) {
    publicUrl = 'https://' + publicUrl;
  }
  return publicUrl.replace(/\/+$/g, '');
}
const R2_PUBLIC_URL = getNormalizedPublicUrl();

function humanFileLabel(bytes) {
  // returns strings like "2ko" (KB) or "1mo" (MB), rounded
  if (!bytes && bytes !== 0) return '0ko';
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)}ko`;
  const mb = kb / 1024;
  if (mb < 1024) return `${Math.round(mb)}mo`;
  const gb = mb / 1024;
  return `${Math.round(gb)}go`;
}

function formatPercent(loaded, total) {
  if (!total) return '0%';
  return `${Math.round((loaded / total) * 100)}%`;
}

function getBusboyFactory() {
  if (!BusboyPkg) throw new Error('busboy not installed');
  if (typeof BusboyPkg === 'function') return BusboyPkg;
  if (BusboyPkg && typeof BusboyPkg.Busboy === 'function') return BusboyPkg.Busboy;
  return BusboyPkg;
}

// CORS (allow frontend origin or all during dev)
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-upload-id', 'x-file-size', 'x-file-name'],
}));

app.get('/health', (req, res) => res.json({ ok: true }));

// SSE endpoint
app.get('/progress/:uploadId', (req, res) => {
  const { uploadId } = req.params;
  if (!uploadId) return res.status(400).end('Missing uploadId');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let emitter = uploads.get(uploadId);
  if (!emitter) {
    emitter = new EventEmitter();
    emitter.setMaxListeners(0);
    uploads.set(uploadId, emitter);
  }

  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true, uploadId })}\n\n`);

  const onProgress = (data) => {
    try { res.write(`event: progress\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) {}
  };
  const onDone = (data) => {
    try { res.write(`event: done\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) {}
  };
  const onError = (data) => {
    try { res.write(`event: error\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) {}
  };

  emitter.on('progress', onProgress);
  emitter.on('done', onDone);
  emitter.on('error', onError);

  req.on('close', () => {
    emitter.removeListener('progress', onProgress);
    emitter.removeListener('done', onDone);
    emitter.removeListener('error', onError);
    // if no listeners remain, schedule cleanup
    const remaining = emitter.listenerCount('progress') + emitter.listenerCount('done') + emitter.listenerCount('error');
    if (remaining === 0) {
      setTimeout(() => {
        const e = uploads.get(uploadId);
        if (e && e.listenerCount('progress') + e.listenerCount('done') + e.listenerCount('error') === 0) {
          uploads.delete(uploadId);
        }
      }, 5000);
    }
  });
});

// Upload endpoint (supports multiple files per request)
app.post('/upload', (req, res) => {
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  const clientFileSizeHeader = parseInt(req.headers['x-file-size'] || '0', 10);
  const declaredTotal = clientFileSizeHeader || contentLength || 0;
  const uploadIdHeader = (req.headers['x-upload-id'] || '').toString();

  const Busboy = getBusboyFactory();
  let busboy;
  try {
    busboy = new Busboy({ headers: req.headers, limits: { fileSize: MAX_FILE_BYTES } });
  } catch (err) {
    busboy = Busboy({ headers: req.headers, limits: { fileSize: MAX_FILE_BYTES } });
  }

  let emitter = null;
  if (uploadIdHeader) {
    emitter = uploads.get(uploadIdHeader);
    if (!emitter) {
      emitter = new EventEmitter();
      emitter.setMaxListeners(0);
      uploads.set(uploadIdHeader, emitter);
    }
  }

  const uploadPromises = []; // collect per-file upload promises
  let anyFile = false;

  busboy.on('file', (fieldname, fileStream, filenameOrInfo, maybeEncoding, maybeMime) => {
    anyFile = true;
    // parse filename & mimetype robustly
    let filename = 'file';
    let mimetype = 'application/octet-stream';
    if (typeof filenameOrInfo === 'string') {
      filename = filenameOrInfo || filename;
      mimetype = maybeMime || mimetype;
    } else if (filenameOrInfo && typeof filenameOrInfo === 'object') {
      filename = filenameOrInfo.filename || filename;
      mimetype = filenameOrInfo.mimeType || filenameOrInfo.mime || maybeMime || mimetype;
    }

    filename = path.basename(String(filename || 'file'));
    if (!filename) {
      fileStream.resume();
      return;
    }

    const safeName = `${Date.now()}-${filename.replace(/\s+/g, '_')}`;
    const tempPath = path.join(uploadDir, safeName);
    const writeStream = fs.createWriteStream(tempPath);

    let received = 0;
    const totalForProgress = declaredTotal || (contentLength ? contentLength : 0);

    console.log(`Start receiving ${filename} -> temp: ${tempPath}`);

    // emit receiving progress while writing to disk
    fileStream.on('data', (chunk) => {
      received += chunk.length;
      if (emitter) {
        const percent = totalForProgress ? Math.min(100, Math.floor((received / totalForProgress) * 100)) : null;
        const data = {
          phase: 'receiving',
          filename,
          loaded: received,
          total: totalForProgress || null,
          percent
        };
        emitter.emit('progress', data);
        // log line like: Name.mp4 1mo/2mo. 50%
        const loadedLabel = humanFileLabel(received);
        const totalLabel = totalForProgress ? humanFileLabel(totalForProgress) : humanFileLabel(0);
        console.log(`${filename} ${loadedLabel}/${totalLabel} ${percent !== null ? percent + '%' : ''}`);
      }
    });

    fileStream.on('limit', () => {
      console.warn(`${filename} exceeded limit ${humanFileLabel(MAX_FILE_BYTES)} - aborting`);
      try { fileStream.unpipe(); } catch (e) {}
      try { writeStream.end(); } catch (e) {}
      try { fs.unlinkSync(tempPath); } catch (e) {}
      if (emitter) emitter.emit('error', { message: 'File too large (limit)', filename });
    });

    fileStream.on('error', (err) => {
      console.error(`Read stream error for ${filename}:`, err);
      try { writeStream.end(); } catch (e) {}
      try { fs.unlinkSync(tempPath); } catch (e) {}
      if (emitter) emitter.emit('error', { message: err.message, filename });
    });

    fileStream.pipe(writeStream);

    writeStream.on('error', (err) => {
      console.error(`Write stream error for ${tempPath}:`, err);
      try { fileStream.unpipe(); } catch (e) {}
      try { fs.unlinkSync(tempPath); } catch (e) {}
      if (emitter) emitter.emit('error', { message: err.message, filename });
    });

    // create a promise for this file's lifecycle (receive -> upload -> done)
    const p = new Promise((resolve) => {
      fileStream.on('end', async () => {
        writeStream.end();
        console.log(`${filename} fully received (${humanFileLabel(received)}) — starting upload to R2`);

        // confirm actual size on disk
        let fileSizeOnDisk = received;
        try {
          const st = fs.statSync(tempPath);
          fileSizeOnDisk = st.size;
        } catch (e) {}

        const key = `${Date.now()}-${filename.replace(/\s+/g, '_')}`;
        const fileReadStream = fs.createReadStream(tempPath);

        try {
          const uploader = new Upload({
            client: s3,
            params: {
              Bucket: process.env.R2_BUCKET,
              Key: key,
              Body: fileReadStream,
              ContentType: mimetype || 'application/octet-stream',
            },
            queueSize: 4,
            partSize: 10 * 1024 * 1024,
            leavePartsOnError: false,
          });

          uploader.on('httpUploadProgress', (progress) => {
            const loaded = progress.loaded || 0;
            const total = progress.total || fileSizeOnDisk || 0;
            const percent = total ? Math.min(100, Math.floor((loaded / total) * 100)) : null;
            if (emitter) {
              const data = {
                phase: 'uploading',
                filename,
                loaded,
                total,
                percent
              };
              emitter.emit('progress', data);
              // console log like: Name.mp4 1mo/2mo. 50%
              const loadedLabel = humanFileLabel(loaded);
              const totalLabel = humanFileLabel(total);
              console.log(`${filename} ${loadedLabel}/${totalLabel} ${percent !== null ? percent + '%' : ''}`);
            }
          });

          await uploader.done();

          try { fs.unlinkSync(tempPath); } catch (e) { console.warn('Could not delete temp file', e); }

          const fileUrl = R2_PUBLIC_URL ? `${R2_PUBLIC_URL}/${key}` : `/${key}`;

          // emit done for this file
          if (emitter) {
            const doneData = { filename, url: fileUrl, key };
            emitter.emit('done', doneData);
            console.log(`${filename} uploaded -> ${fileUrl}`);
          }

          // resolve success
          resolve({ filename, url: fileUrl, key });
        } catch (err) {
          console.error('Upload to R2 failed for', filename, err);
          try { fs.unlinkSync(tempPath); } catch (e) {}
          if (emitter) emitter.emit('error', { message: err.message, filename });
          resolve({ filename, error: err.message });
        }
      });
    });

    uploadPromises.push(p);
  });

  busboy.on('field', (name, val) => {
    // accept normal form fields if needed; not used now
  });

  busboy.on('finish', async () => {
    if (!anyFile) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // wait for all file uploads to finish (success or error)
    try {
      const files = await Promise.all(uploadPromises);
      // send consolidated response
      return res.json({ ok: true, files });
    } catch (err) {
      console.error('Error awaiting uploads', err);
      return res.status(500).json({ error: 'Upload processing failed', details: err.message });
    } finally {
      // cleanup emitters for this uploadId after short delay
      if (uploadIdHeader) {
        setTimeout(() => {
          const e = uploads.get(uploadIdHeader);
          if (e && e.listenerCount('progress') + e.listenerCount('done') + e.listenerCount('error') === 0) {
            uploads.delete(uploadIdHeader);
          }
        }, 2000);
      }
    }
  });

  busboy.on('error', (err) => {
    console.error('Busboy parse error', err);
    if (emitter) emitter.emit('error', { message: err.message });
    return res.status(500).json({ error: 'Parse error', details: err.message });
  });

  req.pipe(busboy);
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Max upload size set to ${humanFileLabel(MAX_FILE_BYTES)} (${MAX_FILE_BYTES} bytes).`);
});
