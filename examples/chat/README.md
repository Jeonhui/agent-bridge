# agent-chat

A terminal chat app built on AgentBridge — the smallest complete host application.

```bash
pnpm install          # from the repository root
node index.mjs        # needs the claude CLI installed and logged in
```

What you will see:

```text
you    add a haiku about autumn to haiku.txt

  ⚙ mcp__fs__write_file {"path":"haiku.txt","content":"..."}

approve? agent wants mcp__fs__write_file (WRITE) {"path":"haiku.txt"...}  [y/N] y

agent  Done — saved to haiku.txt.
```

Three things are happening, and they are the whole AgentBridge story:

1. The reply renders in *this* program. The agent CLI never draws its own UI.
2. The agent is using a tool this app provided (`fs-mcp.mjs`, a 90-line sandboxed
   filesystem server — dependency-free, so you can read all of it).
3. The write stopped until *you* pressed `y`. Deny it and the file is untouched.
   Approvals are remembered for the session, so the second write will not ask.

Everything lives in `sandbox/`; the agent cannot escape it.

Two more conveniences worth trying:

```text
/tools           what this session can see — its MCP servers and every tool with its permissions
/model haiku     switch models mid-conversation; the context survives, because turns run as
                 separate CLI processes and continuity lives in the CLI's own session id
```

Start on a specific model with `node index.mjs --model sonnet`.
