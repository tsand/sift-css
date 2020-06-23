import * as fs from 'fs'
import * as http from 'http';
import * as path from 'path'

import { sift } from '../src/sift'

describe('Sift', () => {
    let server: http.Server
    let port: number

    beforeAll(() => {
        return new Promise(function(resolve) {
            server = http.createServer((request, response) => {
                let filePath = '.' + request.url;
                if (filePath == './') {
                    filePath = './test/index.html';
                }

                const extname = path.extname(filePath).toLowerCase()
                const mimeTypes: {[key: string]: string} = {
                    '.html': 'text/html',
                    '.css': 'text/css',
                }
                const contentType = mimeTypes[extname] || 'application/octet-stream';

                fs.readFile(filePath, function(_, content) {
                    response.writeHead(200, {'Content-Type': contentType});
                    response.end(content, 'utf-8');
                });
            })
            server.listen(0, () => {
                port = (server.address() as {port: number}).port
                resolve()
            });
        });
    })

    afterAll(() => {
        return new Promise(function(resolve) {
            server?.close(resolve);
        });
    })

    it('should remove unused CSS', async () => {
        const url = `http://localhost:${port}`
        const result = await sift(url)
        expect(result.files.length).toEqual(1)
        expect(result.files[0].url).toEqual(url + '/test/style.css')
        expect(result.files[0].sifted).toBeCloseTo(45)
    })
})
