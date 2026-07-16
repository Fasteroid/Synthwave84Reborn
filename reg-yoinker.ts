import { readFileSync, writeFileSync } from "fs";

const REG     = "vs2022-theming.reg";
const YOINKER = /Cache\\{(.*?)}.*?"ItemAndFontInfo"=hex:(.*?)"/gs;

function parseHexBlob(blob: string) {
    blob = blob
    .replace(/\\\r\n/gs, '')
    .replace(/\s/gs, '')
    ;
    
    const ret = blob.split(",").map( byte => parseInt(byte, 16) );
    // console.log(ret.toString());
    return ret;
}

// shamefully vibecoded method, idgaf
function parseFullVSBlob(data: number[]) {
    if (!data || data.length === 0) return null;
    
    const buffer = new Uint8Array(data).buffer;
    const view = new DataView(buffer);
    
    // Detect format style paradigm
    const isFontsAndColors = data[1] === 0 && data[0] >= 32 && data[0] <= 126;
    
    const toHexColor = (bytes) => 
    '#' + bytes.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    
    const toHex32 = (dv, offset) => 
    '0x' + dv.getUint32(offset, true).toString(16).toUpperCase().padStart(8, '0');
    
    // Helper to read a null-terminated UTF-16LE string
    function readUtf16String(offset) {
        let str = "";
        let idx = offset;
        while (idx + 1 < data.length) {
            const low = data[idx];
            const high = data[idx + 1];
            if (low === 0 && high === 0) {
                return { text: str, nextOffset: idx + 2 };
            }
            if (high === 0) {
                str += String.fromCharCode(low);
            }
            idx += 2;
        }
        return { text: str, nextOffset: data.length };
    }
    
    // ==========================================
    // PARSE PARADIGM 1: FONTS & COLORS STORAGE
    // ==========================================
    if (isFontsAndColors) {
        // 1. Parse Font Family Name
        const fontParse = readUtf16String(0);
        let idx = fontParse.nextOffset;
        
        // 2. Parse Font Size (2 bytes)
        const fontSize = view.getUint16(idx, true);
        idx += 2;
        
        const entries: any[] = [];
        
        // 3. Scan for the first token name pair position
        while (idx < data.length) {
            if (idx + 1 < data.length && data[idx] >= 32 && data[idx] <= 126 && data[idx + 1] === 0) {
                // We found the start of a token item definition
                const canonicalParse = readUtf16String(idx);
                const displayParse = readUtf16String(canonicalParse.nextOffset);
                
                let metaIdx = displayParse.nextOffset;
                if (metaIdx + 78 <= data.length) {
                    // Extract structural tracking references from the 78-byte block
                    const fgRef = toHex32(view, metaIdx);
                    const bgRef = toHex32(view, metaIdx + 4);
                    
                    // Slice out raw fallback color cache bytes
                    const fallbackBytes = data.slice(metaIdx + 22, metaIdx + 25);
                    const fallbackColorCache = toHexColor(fallbackBytes.reverse());
                    
                    entries.push({
                        canonicalName: canonicalParse.text,
                        displayName: displayParse.text,
                        fgTrackingRef: fgRef,
                        bgTrackingRef: bgRef,
                        fallbackColorCache
                    });
                    
                    idx = metaIdx + 78; // Skip the metadata block to find the next item
                    continue;
                }
            }
            idx++;
        }
        
        return {
            format: "FontsAndColorsStorage",
            metadata: { fontName: fontParse.text, fontSize: fontSize },
            entries
        };
    }
    
    // ==========================================
    // PARSE PARADIGM 2: THEME BLOB (PKGDEF/SHELL)
    // ==========================================
    if (data.length >= 32) {
        const totalLen = view.getUint32(0, true);
        const flags = view.getUint32(4, true);
        const version = view.getUint32(8, true);
        
        // Reconstruct Category GUID field blocks
        const d1 = view.getUint32(12, true).toString(16).padStart(8, '0');
        const d2 = view.getUint16(16, true).toString(16).padStart(4, '0');
        const d3 = view.getUint16(18, true).toString(16).padStart(4, '0');
        const d4 = data.slice(20, 22).map(b => b.toString(16).padStart(2, '0')).join('');
        const d5 = data.slice(22, 28).map(b => b.toString(16).padStart(2, '0')).join('');
        const categoryGuid = `${d1}-${d2}-${d3}-${d4}-${d5}`.toUpperCase();
        
        const numEntries = view.getUint32(28, true);
        const entries: any[] = [];
        
        let idx = 32;
        for (let i = 0; i < numEntries; i++) {
            if (idx + 4 > data.length) break;
            
            const strLen = view.getUint32(idx, true);
            idx += 4;
            
            if (idx + strLen + 6 > data.length) break;
            
            const nameBytes = data.slice(idx, idx + strLen);
            const name = String.fromCharCode(...nameBytes);
            idx += strLen;
            
            const cdata = data.slice(idx, idx + 6);
            idx += 6;
            
            let bg: string | null = null;
            let fg: string | null = null;
            
            if (cdata[0] === 1) {
                bg = toHexColor(cdata.slice(1, 5));
            } else if (cdata[0] === 0 && cdata[1] === 1) {
                fg = toHexColor(cdata.slice(2, 6));
            }
            
            entries.push({
                name,
                bg,
                fg,
                rawColorPacket: cdata.map(b => b.toString(16).padStart(2, '0')).join(' ')
            });
        }
        
        return {
            format: "ThemeColorBlob",
            metadata: { totalLen, flags, version, categoryGuid },
            entries
        };
    }
    
    return null;
}

const file = readFileSync(REG, {encoding: 'utf16le'});
const blobs = new Map<string, any>();

let match: RegExpExecArray | null;
do {
    match = YOINKER.exec(file);
    if( match ){
        blobs.set(
            match[1], 
            parseFullVSBlob( parseHexBlob(match[2]) )
        );
    }
}
while (match)

writeFileSync("vs2022-theming.json", JSON.stringify( Object.fromEntries(blobs), null, 2 ) )
    
    