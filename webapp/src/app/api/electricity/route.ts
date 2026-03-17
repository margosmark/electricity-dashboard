import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { XMLParser } from 'fast-xml-parser';

// Paths
const UPLOADED_XML_PATH = path.resolve(process.cwd(), '.data/electricity.xml');
const FALLBACK_XML_PATH = path.resolve(process.cwd(), '../electricit2024-now.xml');
const CACHE_PATH = path.resolve(process.cwd(), '.data/parsed_cache.json');

/**
 * Ensures the data directory exists.
 */
function ensureDataDir() {
  const dir = path.dirname(UPLOADED_XML_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Core parsing logic. Reads the XML and converts it to a clean JSON array.
 */
function parseXMLFile(filePath: string) {
  const xmlData = fs.readFileSync(filePath, 'utf8');
  
  const parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    isArray: (name) => { 
      return ['IntervalReading', 'entry', 'IntervalBlock'].includes(name);
    }
  });
  
  const parsed = parser.parse(xmlData);
  const readings: { timestamp: number, usage_kwh: number }[] = [];
  
  // Recursive function to deeply find all IntervalReading elements
  function traverse(obj: any) {
    if (!obj) return;
    
    if (Array.isArray(obj)) {
      obj.forEach(traverse);
    } else if (typeof obj === 'object') {
      if (obj.IntervalReading) {
         const arr = Array.isArray(obj.IntervalReading) ? obj.IntervalReading : [obj.IntervalReading];
         arr.forEach((ir: any) => {
           const start = parseInt(ir.timePeriod?.start || "0", 10);
           const value = parseInt(ir.value || "0", 10);
           if (start > 0) {
             readings.push({ 
                 timestamp: start, 
                 usage_kwh: value / 1000.0 // Convert Wh to kWh
             });
           }
         });
      }
      for (const key in obj) {
        if (key !== 'IntervalReading') {
          traverse(obj[key]);
        }
      }
    }
  }
  
  traverse(parsed);
  
  // Sort chronologically
  readings.sort((a, b) => a.timestamp - b.timestamp);
  return readings;
}

export async function GET() {
  ensureDataDir();

  // Determine which XML file to use
  let activeXmlPath = UPLOADED_XML_PATH;
  if (!fs.existsSync(activeXmlPath)) {
    activeXmlPath = FALLBACK_XML_PATH;
  }

  try {
    if (!fs.existsSync(activeXmlPath)) {
      return NextResponse.json({ error: "Data file not found. Please upload a file." }, { status: 404 });
    }

    const xmlStats = fs.statSync(activeXmlPath);
    
    // Check Cache
    if (fs.existsSync(CACHE_PATH)) {
      const cacheStats = fs.statSync(CACHE_PATH);
      // If cache is newer than the XML, return cache directly
      if (cacheStats.mtime > xmlStats.mtime) {
        const cacheData = fs.readFileSync(CACHE_PATH, 'utf8');
        return NextResponse.json({ data: JSON.parse(cacheData), cached: true });
      }
    }

    // Parse and generate new cache
    console.log("Parsing XML Data...");
    const readings = parseXMLFile(activeXmlPath);
    
    // Save to cache
    fs.writeFileSync(CACHE_PATH, JSON.stringify(readings), 'utf8');

    return NextResponse.json({ data: readings, cached: false });

  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  ensureDataDir();

  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;
    
    if (!file) {
      return NextResponse.json({ error: "No file uploaded." }, { status: 400 });
    }

    // Read file buffer and save to local disk
    const buffer = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(UPLOADED_XML_PATH, buffer);

    // Invalidate Cache
    if (fs.existsSync(CACHE_PATH)) {
      fs.unlinkSync(CACHE_PATH);
    }

    return NextResponse.json({ success: true, message: "File uploaded successfully." });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
