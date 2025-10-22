require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const s3 = new S3Client({
    endpoint: process.env.R2_ENDPOINT,
    region: process.env.R2_REGION,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
});

// Middleware pou static files (front-end)
app.use(express.static('public'));

// Upload endpoint
app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');

    const key = req.file.originalname;

    try {
        await s3.send(new PutObjectCommand({
            Bucket: process.env.R2_BUCKET,
            Key: key,
            Body: req.file.buffer,
            ContentType: req.file.mimetype,
            ACL: 'public-read' // pou li ka vizib piblikman
        }));

        const publicUrl = `${process.env.R2_PUBLIC_URL}/${key}`;
        res.json({ message: 'Upload successful!', url: publicUrl });
    } catch (err) {
        console.error(err);
        res.status(500).send('Upload failed.');
    }
});

app.listen(process.env.PORT || 3000, () => {
    console.log(`Server running on http://localhost:${process.env.PORT || 3000}`);
});
