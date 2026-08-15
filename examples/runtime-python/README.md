# Driving AgentBridge from Python

No SDK and no Node: REST for control, WebSocket for events. The client here uses only the Python
standard library, including a hand-rolled WebSocket handshake, to show the wire protocol is enough.

```bash
pnpm serve                      # prints {"host":..., "port":..., "token":...}
python3 client.py http://127.0.0.1:<port> <token>
```

The same shape works from Swift, Kotlin, Java, C#, or anything else that speaks HTTP.
