import * as fs from "fs";
import * as path from "path";
import * as postcss from 'postcss';
import type { Protocol } from 'devtools-protocol';

import { BrowserClient } from './browser'

export async function sift(
    url: string,
    interactive = false,
    scaleViewport = false,
    outDir?: string,
    outExt = ".sift.css",
): Promise<SiftResult> {
    const browser = new BrowserClient(!interactive);
    await browser.start();
    const page = await browser.newPage(true);

    const styleSheetHeaders: { [key: string]: Protocol.CSS.CSSStyleSheetHeader } = {};
    const styleSheetData: { [key: string]: string } = {};
    browser.onStyleSheetAdded(async (event: Protocol.CSS.StyleSheetAddedEvent) => {
        styleSheetHeaders[event.header.styleSheetId] = event.header;
        styleSheetData[event.header.styleSheetId] = await browser.getStyleSheetText(event.header.styleSheetId);
    })

    await browser.startCSSRuleUsageTracking();
    await page.goto(url);

    // Manipulate page
    if (interactive) {
        // TODO: Need to get coverage data before browser is closed (maybe refresh inside loop?)
        await browser.waitForDisconnect();
    } else if (scaleViewport) {
        // Scale viewport to capture media queries
        let width = 1400
        while (width > 0) {
            await page.setViewport({width: width, height: 1080});
            width -= 100;
        }
    }

    const usedStyleSheetIds: Set<string> = new Set()
    const ruleByStartID: { [key: string]: Protocol.CSS.RuleUsage } = {};

    const delta = await browser.stopCSSRuleUsageTracking();

    console.log(delta)
    const coverage = delta.filter((r) => r.used);
    for (const rule of coverage) {
        usedStyleSheetIds.add(rule.styleSheetId);

        // Fetch stylesheet data if needed
        // TODO: This shouldn't be needed
        if (!(rule.styleSheetId in styleSheetData)) {
            styleSheetData[rule.styleSheetId] = await browser.getStyleSheetText(rule.styleSheetId)
        }

        const charRange = ruleToCharRange(rule, styleSheetData[rule.styleSheetId])
        const startID = `${rule.styleSheetId}:${charRange.start?.line}:${charRange.start?.column}`
        ruleByStartID[startID] = rule
    }

    const outData: { [key: string]: Array<string> } = {};

    // Fetch stylesheet data for used rules
    const syntaxTrees: { [key: string]: postcss.Root } = {};
    for (const styleSheetId of usedStyleSheetIds) {
        const ast = postcss.parse(styleSheetData[styleSheetId]);
        syntaxTrees[styleSheetId] = ast;

        // Walk it
        ast.walkRules((r) => {
            const startID = `${styleSheetId}:${r.source?.start?.line}:${r.source?.start?.column}`
            if (startID in ruleByStartID) {
                if (!(styleSheetId in outData)) {
                    outData[styleSheetId] = [];
                }
                outData[styleSheetId].push(ruleToString(r))
            }
        })
    }

    const result: SiftResult = {files: []};
    for (const styleSheetId in outData) {
        const data = outData[styleSheetId].join('\n')
        const sourceUrl = new URL(styleSheetHeaders[styleSheetId].sourceURL)
        result.files.push({
            url: sourceUrl.toString(),
            data: data,
            sifted: styleSheetData[styleSheetId].length - data.length
        })

        if (outDir) {
            let outFile = outDir.replace(/\/$/, '') + sourceUrl.pathname

            const basename = path.basename(outFile)
            const dir = outFile.replace(basename, '')
            outFile = dir + basename.substr(0, basename.indexOf(".")) + outExt;

            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, {recursive: true})
            }

            fs.writeFileSync(outFile, data)
        } else {
            // TODO: Remove print
            console.log('// ' + sourceUrl.toString())
            console.log(data)
        }
    }

    await browser.stop()

    return result
}

interface SiftResult {
    files: Array<{url: string, data: string, sifted: number}>
}

interface charID {
    line: number;
    column: number;
}

interface charRange {
    start?: charID
    end?: charID
}

function ruleToCharRange(rule: Protocol.CSS.RuleUsage, styleSheetData: string): charRange {
    let cursor = 0;
    let lineNum = 1;
    const range: charRange = {};

    for (const line of styleSheetData.split('\n')) {
        if (!range.start && cursor + line.length >= rule.startOffset) {
            range.start = {
                line: lineNum,
                column: rule.startOffset - cursor + 1
            }
        }

        if (cursor + line.length >= rule.endOffset) {
            range.end = {
                line: lineNum,
                column: rule.endOffset - cursor
            }
            break;
        }

        cursor += line.length + 1; // include newline character
        lineNum++;
    }

    return range
}

function ruleToString(rule: postcss.Rule): string {
    if (rule.parent.type == 'atrule' && rule.parent.name == 'media') {
        return rule.parent.toString()
    }
    return rule.toString()
}
