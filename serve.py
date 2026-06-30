"""Servidor de desarrollo sin caché para ReWind (SHM de torres eólicas).
Uso: python serve.py [puerto]   (puerto por defecto: 8765)
"""
import http.server, socketserver, os, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def guess_type(self, path):
        # Manifest PWA: tipo correcto para que el navegador lo acepte
        if str(path).endswith('.webmanifest'):
            return 'application/manifest+json; charset=UTF-8'
        ctype = super().guess_type(path)
        if isinstance(ctype, str):
            if ctype in ('text/javascript', 'application/javascript', 'text/css', 'text/html'):
                ctype = ctype + '; charset=UTF-8'
        return ctype

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # silenciar logs de acceso

os.chdir(os.path.dirname(os.path.abspath(__file__)))

# Multihilo: el servidor monohilo (TCPServer) se ahogaba con las cargas paralelas
# de módulos ES (Three.js + varios .js a la vez) → ConnectionAbortedError y
# conexiones rechazadas. ThreadingTCPServer atiende peticiones concurrentes.
class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

with Server(('', PORT), NoCacheHandler) as httpd:
    print(f'ReWind -> http://localhost:{PORT}')
    httpd.serve_forever()
