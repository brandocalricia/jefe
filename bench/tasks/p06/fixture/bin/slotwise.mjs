#!/usr/bin/env node
import { run } from '../src/cli.mjs';

const { code, stdout, stderr } = run(process.argv.slice(2));
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = code;
