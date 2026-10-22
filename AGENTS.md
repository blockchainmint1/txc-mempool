# Infrastructure rules
- Keep the Docker indexer's resource controls in a browser-independent module and test them offline; the AWS Node service is separate from the site's Worker runtime.
- Bound both active RPC work and queued waiters, and use request deadlines for history; an unlimited waiting queue retains memory during overload.
- Resolve transaction parents with bounded workers and compact request-local single-flight caches; full parent transactions multiply memory use.