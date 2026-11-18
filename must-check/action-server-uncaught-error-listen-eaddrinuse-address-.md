# Recurring app action/error — server-uncaught
- signature: `crash:server-uncaught:error: listen eaddrinuse: address already in use #.#.#.#:# at server.setuplistenhandle [as _listen#] (node:net:#:#) at listenincluster (node:net:#:#) at node:ne`
- seen: **1×**, first 2026-11-18T22:07:36.116Z, last 2026-11-18T22:07:36.116Z
- status: new
## Error
```
Error: listen EADDRINUSE: address already in use 0.0.0.0:3000
    at Server.setupListenHandle [as _listen2] (node:net:2008:16)
    at listenInCluster (node:net:2065:12)
    at node:net:2274:7
    at process.processTicksAndRejections (node:internal/process/task_queues:90:21)
```
## Context
```json
{
  "detail": null
}
```
## Notes for the fixer
(append findings here; auto-sync carries this file to GitHub and back)
