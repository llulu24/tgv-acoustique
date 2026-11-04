# Serveur web local de l'application : interdit au navigateur de garder des copies périmées.
import http.server, sys, functools, os
# En-têtes de sécurité : mêmes valeurs que le fichier Caddyfile (publication HTTPS).
SECURITY_HEADERS = {
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.openfreemap.org; font-src 'self' data: https://*.openfreemap.org; connect-src 'self' https://*.openfreemap.org; worker-src 'self' blob:; child-src blob:; media-src 'self' blob:; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "microphone=(self), geolocation=(self), camera=(), payment=(), usb=()",
}
class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".webmanifest": "application/manifest+json", ".js": "text/javascript", ".wasm": "application/wasm"}
    def do_POST(self):
        # Essai sur tablette (autotest-v099.js) : le résultat est écrit dans resultats_test_tablette.json, rien d'autre.
        if self.path != "/__resultat":
            self.send_error(404); return
        n = int(self.headers.get("Content-Length", "0") or 0)
        if n <= 0 or n > 2 * 1024 * 1024:
            self.send_error(413); return
        data = self.rfile.read(n)
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "resultats_test_tablette.json"), "wb") as f:
            f.write(data)
        self.send_response(204); self.end_headers()
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        for k, v in SECURITY_HEADERS.items(): self.send_header(k, v)
        super().end_headers()
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
root = os.path.dirname(os.path.abspath(__file__))
handler = functools.partial(NoCacheHandler, directory=root)
http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
