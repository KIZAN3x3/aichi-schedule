function sendJson(res, status, body) {
  if (body === null) {
    res.status(status).end();
    return;
  }
  res.status(status).json(body);
}

function methodNotAllowed(res, allowed) {
  res.setHeader('Allow', allowed.join(', '));
  sendJson(res, 405, { error: 'Method Not Allowed' });
}

module.exports = { sendJson, methodNotAllowed };
