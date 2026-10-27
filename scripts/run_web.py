"""
Launch Assistive Navigation System V2 Testing Web Studio
=========================================================

Usage:
    python scripts/run_web.py                     # Local desktop testing (http://127.0.0.1:8000)
    python scripts/run_web.py --mobile            # Phone testing over Wi-Fi with HTTPS & QR code!
    python scripts/run_web.py --port 8080         # Custom port
"""

import argparse
import datetime
import ipaddress
import socket
import sys
import webbrowser
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT / "src"))

import uvicorn


def get_local_ip() -> str:
    """Finds the local network IP address of this machine."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = '127.0.0.1'
    finally:
        s.close()
    return ip


def generate_self_signed_cert(cert_path: Path, key_path: Path, host_ip: str):
    """
    Generates a local self-signed SSL certificate so phones can access
    the camera via navigator.mediaDevices.getUserMedia (which requires HTTPS).
    """
    try:
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
    except ImportError:
        print("ERROR: cryptography package required. Run: pip install cryptography")
        sys.exit(1)

    print("Generating self-signed SSL certificate for phone HTTPS access...")
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, u"AssistiveNavigationLocal")
    ])

    san_list = [
        x509.DNSName(u"localhost"),
        x509.IPAddress(ipaddress.IPv4Address(u"127.0.0.1")),
    ]
    try:
        san_list.append(x509.IPAddress(ipaddress.IPv4Address(host_ip)))
    except Exception:
        pass

    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=1))
        .not_valid_after(datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=365))
        .add_extension(x509.SubjectAlternativeName(san_list), critical=False)
        .sign(key, hashes.SHA256())
    )

    cert_path.parent.mkdir(parents=True, exist_ok=True)
    with open(key_path, "wb") as f:
        f.write(key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption()
        ))
    with open(cert_path, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))
    print(f"  Certificate created: {cert_path}")


def print_qr_code(url: str):
    """Prints an ASCII QR code to the terminal for easy phone camera scanning."""
    try:
        import qrcode
        qr = qrcode.QRCode(border=1)
        qr.add_data(url)
        qr.make(fit=True)
        print("\n  Scan this QR code with your phone camera:")
        qr.print_ascii(invert=True)
    except Exception:
        pass


def main():
    parser = argparse.ArgumentParser(description="Assistive Navigation Testing Studio Launcher")
    parser.add_argument("--host", default="127.0.0.1", help="Host address (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000, help="Port to listen on (default: 8000)")
    parser.add_argument("--mobile", action="store_true", help="Enable mobile phone mode (listens on 0.0.0.0 with HTTPS & QR code)")
    parser.add_argument("--ssl", action="store_true", help="Force HTTPS using self-signed cert")
    parser.add_argument("--open-browser", action="store_true", help="Automatically open web browser on start")
    parser.add_argument("--reload", action="store_true", help="Enable auto-reload on code changes")

    args = parser.parse_args()

    local_ip = get_local_ip()
    use_ssl = args.ssl or args.mobile
    host = "0.0.0.0" if args.mobile else args.host

    cert_path = _PROJECT_ROOT / "models" / "cert.pem"
    key_path = _PROJECT_ROOT / "models" / "key.pem"

    if use_ssl:
        if not (cert_path.exists() and key_path.exists()):
            generate_self_signed_cert(cert_path, key_path, local_ip)
        scheme = "https"
    else:
        scheme = "http"

    local_url = f"{scheme}://localhost:{args.port}"
    mobile_url = f"{scheme}://{local_ip}:{args.port}"

    print("=" * 72)
    print("  ASSISTIVE NAVIGATION SYSTEM V2 — TESTING STUDIO")
    print("=" * 72)
    print(f"  Desktop URL : {local_url}")
    if args.mobile or host == "0.0.0.0":
        print(f"  Phone URL   : {mobile_url}")
        print("-" * 72)
        print("  HOW TO CONNECT YOUR PHONE:")
        print("  1. Connect your phone to the SAME Wi-Fi network as this laptop.")
        print(f"  2. Open Chrome/Safari on your phone and browse to:")
        print(f"     --> {mobile_url}")
        print("  3. When browser warns 'Your connection is not private' (self-signed cert):")
        print("     Tap 'Advanced' -> 'Proceed to 192.168.x.x (unsafe)'")
        print("  4. Allow Camera permission when prompted.")
        print_qr_code(mobile_url)
    print("=" * 72)
    print("  Press Ctrl+C to stop the server.\n")

    if args.open_browser:
        import threading
        import time
        threading.Thread(target=lambda: (time.sleep(1.0), webbrowser.open(local_url)), daemon=True).start()

    ssl_kwargs = {}
    if use_ssl:
        ssl_kwargs["ssl_keyfile"] = str(key_path)
        ssl_kwargs["ssl_certfile"] = str(cert_path)

    uvicorn.run(
        "assistive_navigation.web.app:app",
        host=host,
        port=args.port,
        reload=args.reload,
        log_level="info",
        **ssl_kwargs
    )


if __name__ == "__main__":
    main()
