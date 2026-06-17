import webview
import threading
import sys
import os
import uvicorn
import socket
import time

# Add the backend path so we can import the FastAPI app
sys.path.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'backend'))
from backend.main import app

def get_free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("",0))
    s.listen(1)
    port = s.getsockname()[1]
    s.close()
    return port

def run_server(port):
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")

def main():
    # Find a free local port
    port = get_free_port()
    
    # Start FastAPI server in a background thread
    server_thread = threading.Thread(target=run_server, args=(port,), daemon=True)
    server_thread.start()

    # Wait briefly for server to start
    time.sleep(2)

    # Launch PyWebView window pointing to our local FastAPI server
    url = f"http://127.0.0.1:{port}/retro_preview.html"

    class WindowAPI:
        def __init__(self):
            self.win = None
            self.is_maximized = False

        def set_window(self, win):
            self.win = win

        def minimize(self):
            if self.win:
                self.win.minimize()

        def maximize(self):
            if self.win:
                if self.is_maximized:
                    self.win.restore()
                    self.is_maximized = False
                else:
                    self.win.maximize()
                    self.is_maximized = True

        def close(self):
            if self.win:
                self.win.destroy()

    api = WindowAPI()
    window = webview.create_window(
        title="Optical Link Budget Calculator",
        url=url,
        width=1200,
        height=850,
        min_size=(900, 600),
        frameless=True,
        js_api=api
    )
    api.set_window(window)

    # Start the webview application
    webview.start()

if __name__ == '__main__':
    main()
