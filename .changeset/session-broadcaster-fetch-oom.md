---
"@aoagents/ao-web": patch
---

Fix mux session snapshot polling so rapid dashboard reconnects do not pile up duplicate uncancelled requests to the Next.js dashboard server. SessionBroadcaster now shares an in-flight snapshot fetch across subscribers, aborts it when the final subscriber disconnects, and keeps the timeout active until the response body is consumed.
