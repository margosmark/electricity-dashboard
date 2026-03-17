import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { XMLParser } from 'fast-xml-parser';

export async function GET() {
  const filePath = path.resolve(process.cwd(), '../electricit2024-now.xml');
  
  try {
    if (!fs.existsSync(filePath)) {
      return NextResponse.json({ error: "Data file not found" }, { status: 404 });
    }

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

    return NextResponse.json({ data: readings });

  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
