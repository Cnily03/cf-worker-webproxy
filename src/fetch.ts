import net from "node:net";
import zlib from "node:zlib";

function decomporessGzip(buf: ReadableStream): ReadableStream {
    const gunzip = zlib.createGunzip();
    const stream = new ReadableStream({
        start(controller) {
            const writable = new WritableStream({
                write(chunk) {
                    gunzip.write(chunk);
                },
                close() {
                    gunzip.end();
                }
            })
            buf.pipeTo(writable);
            gunzip.on('data', (chunk) => {
                controller.enqueue(chunk);
            });
            gunzip.on('end', () => {
                controller.close();
            });
        }
    });
    return stream;
}

function parse_head_string(head_string: string) {
    const head_lines = head_string.split('\r\n');
    const first_line = head_lines.shift() || '';
    const [version, status, ...status_text] = first_line.split(' ');
    const status_text_str = status_text.join(' ');
    const version_str = version.split('/')[1];
    return {
        version: version_str,
        status: parseInt(status),
        statusText: status_text_str,
        headers: new Headers(head_lines.map(line => {
            let arr = line.split(': ');
            return [arr.shift() || '', arr.join(': ').trim()];
        })),
    }
}

function http_fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
    let throw_error = true;
    return new Promise((resolve: (value: Response) => void, reject: (reason: any) => void) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        const HOST = url.hostname, PORT = parseInt(url.port) || (url.protocol === "https:" ? 443 : 80);
        const socket = new net.Socket();
        socket.connect(PORT, HOST, function () {
            const method = request.method.toUpperCase();
            const path = url.pathname + url.search;
            const version = 'HTTP/1.1';
            const headers = new Headers(request.headers);
            const lines = [`${method} ${path} ${version}`];
            headers.forEach((value, key) => lines.push(`${key}: ${value}`));
            lines.push('');
            // send head
            socket.write(lines.join('\r\n') + '\r\n');
            // send body
            if (request.body) {
                if (request.body instanceof ReadableStream) {
                    request.body.pipeTo(new WritableStream({
                        write(chunk) {
                            socket.write(chunk);
                        }
                    }));
                } else {
                    socket.write(request.body);
                }
            }
        });
        throw_error = false;
        let head_string = ''
        let receiving_body = false;
        let have_resolved = false;
        let content_length = 0;
        let received_length = 0;
        const response_body_reader = new ReadableStream({
            start(controller) {
                socket.on('data', (data) => {
                    if (receiving_body) {
                        if (received_length + data.length >= content_length) {
                            const append_length = content_length - received_length;
                            received_length = content_length;
                            controller.enqueue(data.subarray(0, append_length));
                            controller.close();
                            socket.end();
                            return;
                        } else {
                            received_length += data.length;
                            console.log('received_length:', received_length);
                            controller.enqueue(data);
                        }
                    }
                    const end = data.indexOf('\r\n\r\n');
                    if (end === -1) {
                        head_string += data.toString();
                        return;
                    } else {
                        receiving_body = true;
                        have_resolved = true;
                        head_string += data.subarray(0, end).toString();
                        const o = parse_head_string(head_string);
                        const encoding = o.headers.get('Content-Encoding');
                        const stream = encoding ? decomporessGzip(response_body_reader) : response_body_reader;
                        const response = new Response(stream, {
                            status: o.status,
                            statusText: o.statusText,
                            headers: o.headers,
                        });
                        content_length = parseInt(o.headers.get('Content-Length') || '0');
                        let append_data = data.subarray(end + 4);
                        if (append_data.length >= content_length) {
                            received_length = content_length;
                            controller.enqueue(append_data.subarray(0, content_length));
                            resolve(response);
                            controller.close();
                            socket.end();
                            return;
                        } else {
                            received_length += append_data.length;
                            controller.enqueue(append_data);
                        }
                        resolve(response);
                    }
                });
                socket.on('error', (err) => {
                    reject(err);
                    try { controller.close() } catch (e) { }
                });
                socket.on('end', () => {
                    if (!have_resolved) reject(new Error('Connection closed'));
                    try { controller.close() } catch (e) { }
                });
            }
        });
    }).catch(err => {
        if (throw_error) throw err;
        console.error(err);
        return new Response(null, { status: 502, statusText: "Bad Gateway" });
    })
}

function fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const u = new URL(request.url);
    const header_host = new Request(input, init).headers.get('Host');
    if (u.protocol === "http:" && header_host && header_host !== u.host) {
        return http_fetch(input, init);
    } else {
        return globalThis.fetch(input, init);
    }
}

export default fetch;