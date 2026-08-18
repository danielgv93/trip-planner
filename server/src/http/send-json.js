export function sendJson(res, status, body, headers = {}) {
    res.status(status).set(headers).json(body);
}
