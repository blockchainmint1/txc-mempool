# Infrastructure rules
- Keep the Docker indexer's resource controls in a browser-independent module and test them offline; the AWS Node service is separate from the site's Worker runtime.
- Bound both active RPC work and queued waiters, and use request deadlines for history; an unlimited waiting queue retains memory during overload.
- Resolve transaction parents with bounded workers and compact request-local single-flight caches; full parent transactions multiply memory use.
- Keep Electrum admission and compact pending-transaction projections in Node-only, offline-testable modules; debit every batch entry before dispatch, share a bounded work gate across all lines per connection, and count pre-handshake sockets across both listeners to protect the shared node.