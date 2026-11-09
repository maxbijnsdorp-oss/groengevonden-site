#!/usr/bin/env python3
"""Nep-Resend en nep-Turnstile voor tests/api-tests.sh in de stand mock. Alleen de standaardbibliotheek.

Gebruik: python3 tests/mock_server.py <logbestand> <poortbestand>
Luistert op 127.0.0.1 op een vrije poort en schrijft die poort in <poortbestand>.
Elk verzoek komt als één JSON-regel in <logbestand>: {"pad", "headers", "body"}.

POST /siteverify (Turnstile): success alleen met de testsleutel 1x0000000000000000000000000000000AA
  en de testtoken XXXX.DUMMY.TOKEN.XXXX, net als bij Cloudflare
  (https://developers.cloudflare.com/turnstile/troubleshooting/testing/).
POST /emails (Resend): 200, behalve als de Idempotency-Key een van deze stukjes bevat:
  test-quotum   429 daily_quota_exceeded
  test-replyto  422 zolang er een reply_to in het verzoek zit
  test-dubbel   409 invalid_idempotent_request, behalve als de sleutel eindigt op -opnieuw
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

TEST_SECRET = "1x0000000000000000000000000000000AA"
TEST_TOKEN = "XXXX.DUMMY.TOKEN.XXXX"
LOG = sys.argv[1]


def resend_answer(body, key):
    if "test-quotum" in key:
        return 429, {"name": "daily_quota_exceeded", "message": "You have exceeded your daily email sending quota."}
    if "test-replyto" in key and "reply_to" in body:
        return 422, {"name": "validation_error", "message": "Invalid `reply_to` field."}
    if "test-dubbel" in key and not key.endswith("-opnieuw"):
        return 409, {"name": "invalid_idempotent_request", "message": "This idempotency key has been used."}
    return 200, {"id": "nep-mail"}


class Handler(BaseHTTPRequestHandler):
    def read_body(self):
        if "chunked" in self.headers.get("Transfer-Encoding", "").lower():
            data = b""
            while True:
                size = int(self.rfile.readline().strip().split(b";")[0], 16)
                if size == 0:
                    self.rfile.readline()
                    return data.decode("utf-8")
                data += self.rfile.read(size)
                self.rfile.readline()
        return self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode("utf-8")

    def do_POST(self):
        raw = self.read_body()
        if self.path == "/siteverify":
            body = {key: values[0] for key, values in parse_qs(raw).items()}
            ok = body.get("secret") == TEST_SECRET and body.get("response") == TEST_TOKEN
            status, answer = 200, {"success": ok, "error-codes": [] if ok else ["invalid-input-response"]}
        elif self.path == "/emails":
            body = json.loads(raw)
            status, answer = resend_answer(body, self.headers.get("Idempotency-Key", ""))
        else:
            body = raw
            status, answer = 404, {"message": "onbekend pad"}
        headers = {key.lower(): value for key, value in self.headers.items()}
        with open(LOG, "a", encoding="utf-8") as log:
            log.write(json.dumps({"pad": self.path, "headers": headers, "body": body}, ensure_ascii=False) + "\n")
        data = json.dumps(answer).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    open(LOG, "a", encoding="utf-8").close()
    with open(sys.argv[2], "w", encoding="utf-8") as port_file:
        port_file.write(str(server.server_address[1]))
    server.serve_forever()
