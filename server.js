require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Configure R2 S3 client
const s3 = new S3Client({
  region: process.env.R2_REGION || 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// Normalize public URL helper
function getNormalizedPublicUrl() {
  let publicUrl = (process.env.R2_PUBLIC_URL || '').trim();

  if (!publicUrl) return '';

  // Remove trailing slashes
  publicUrl = publicUrl.replace(/\/+$/g, '');

  // If the value looks like "example.r2.dev" without protocol, add https://
  if (!/^https?:\/\//i.test(publicUrl)) {
    publicUrl = 'https://' + publicUrl;
  }

  return publicUrl;
}

const R2_PUBLIC_URL = getNormalizedPublicUrl();

// Upload route
app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded');

  const key = `${Date.now()}-${req.file.originalname}`;

  // Make sure we have a public URL to return
  const fileUrl = R2_PUBLIC_URL ? `${R2_PUBLIC_URL}/${key}` : `/${key}`;

  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      })
    );

    // Response pou frontend
    res.json({ message: 'Upload successful!', url: fileUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed', details: err.message });
  }
});

// Serve static frontend (index.html nan /public)
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
