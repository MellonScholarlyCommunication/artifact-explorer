#!/usr/bin/env node

import { Command } from 'commander';
import { exploreArtifact } from '../dist/explorer.js';

const program = new Command();

program
    .name('artifact_admin.js')
    .option('-s,--service <service_node>')
    .argument('url')
    .action( async (url,opts) => {
        const result = await exploreArtifact(url,opts.service);
        for await (const member of result) {
            console.log(await member);
        }
    });

program.parse();
