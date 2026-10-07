#!/usr/bin/env node
// Stand-in for $KUBE_EDITOR. kubectl runs this with the temp file it wants edited; we announce the
// path on stdout (which server.js is reading) and block until the server signals on stdin that the
// browser has saved or cancelled. Exiting hands control back to kubectl, which re-reads the file.
process.stdout.write(`\u0001cka-edit ${process.argv[2]}\n`);
process.stdin.once('data', () => process.exit(0));
process.stdin.once('end', () => process.exit(0));
