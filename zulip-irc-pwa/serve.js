#!/usr/bin/env node

/**
 * Simple development server for ZulipIRC PWA
 *
 * Usage: node serve.js [port]
 * Default port: 8080
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.argv[2] || 8080;
const ROOT = __dirname;

const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
    '.webmanifest': 'application/manifest+json'
};

function getMimeType(filepath) {
    const ext = path.extname(filepath).toLowerCase();
    return MIME_TYPES[ext] || 'application/octet-stream';
}

function serveFile(res, filepath) {
    fs.readFile(filepath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
            return;
        }

        const mimeType = getMimeType(filepath);
        res.writeHead(200, {
            'Content-Type': mimeType,
            'Cache-Control': 'no-cache',
            // Required for Service Worker
            'Service-Worker-Allowed': '/'
        });
        res.end(data);
    });
}

const server = http.createServer((req, res) => {
    // Parse URL
    let url = req.url.split('?')[0];

    // Default to index.html
    if (url === '/') {
        url = '/index.html';
    }

    // Security: prevent directory traversal
    const safePath = path.normalize(url).replace(/^(\.\.(\/|\\|$))+/, '');
    const filepath = path.join(ROOT, safePath);

    // Ensure path is within ROOT
    if (!filepath.startsWith(ROOT)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
    }

    // Check if file exists
    fs.stat(filepath, (err, stats) => {
        if (err || !stats.isFile()) {
            // Try with .html extension
            const htmlPath = filepath + '.html';
            fs.stat(htmlPath, (err2, stats2) => {
                if (!err2 && stats2.isFile()) {
                    serveFile(res, htmlPath);
                } else {
                    // Serve index.html for SPA routing
                    serveFile(res, path.join(ROOT, 'index.html'));
                }
            });
            return;
        }

        serveFile(res, filepath);
    });
});

server.listen(PORT, () => {
    console.log(`ZulipIRC dev server running at http://localhost:${PORT}`);
    console.log(`Test page: http://localhost:${PORT}/tests/`);
    console.log('Press Ctrl+C to stop');
});
