#!/usr/bin/env node

import * as yargs from 'yargs'
import { sift } from '../sift'

yargs.help().alias('h', 'help')

yargs.command('$0 <url>', 'Sift a webpage', yargs => {
    yargs.positional('url', {type: 'string', demandOption: true})
    yargs.options('outDir', {
        describe: 'The name of the directory to output the sifted CSS files',
        type: 'string'
    })
    yargs.options('outExt', {
        describe: 'The extension to use for the sifted CSS files',
        type: 'string',
        default: '.sift.css'
    })
    yargs.options('scaleViewport', {
        describe: 'Whether to scale the viewport down to the smallest width to capture media queries',
        type: 'boolean',
        default: false
    })
})


export interface Arguments {
    url: string
    outDir?: string
    outExt: string,
    scaleViewport: boolean,
}

const argv = yargs.argv as unknown as Arguments;

(async () => {
    await sift(argv)
})();
