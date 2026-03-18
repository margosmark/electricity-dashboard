import xml.etree.ElementTree as ET
import pandas as pd
from datetime import datetime
import pytz

def parse_green_button_xml(file_path):
    # Namespaces used in the Green Button XML
    ns = {
        'atom': 'http://www.w3.org/2005/Atom',
        'espi': 'http://naesb.org/espi'
    }
    
    tree = ET.parse(file_path)
    root = tree.getroot()
    
    data = []
    
    # Find all IntervalReading elements
    # Using relative path to find any IntervalReading regardless of its exact depth
    for reading in root.findall('.//espi:IntervalReading', ns):
        # Extract start time (Unix timestamp)
        time_period = reading.find('espi:timePeriod', ns)
        if time_period is not None:
            start_element = time_period.find('espi:start', ns)
            value_element = reading.find('espi:value', ns)
            
            if start_element is not None and value_element is not None:
                start_timestamp = int(start_element.text)
                value = int(value_element.text)
                
                data.append({
                    'timestamp': start_timestamp,
                    'value': value
                })
                
    # Create DataFrame
    df = pd.DataFrame(data)
    
    if df.empty:
        return df
        
    # Convert timestamp to timezone-aware datetime (America/Toronto for Oakville)
    tz = pytz.timezone('America/Toronto')
    
    # The timestamps are UTC unix timestamps
    df['datetime'] = pd.to_datetime(df['timestamp'], unit='s', utc=True)
    df['datetime'] = df['datetime'].dt.tz_convert(tz)
    
    # Convert Wh to kWh (Oakville Hydro typically reports in Watt-hours for these intervals)
    df['usage_kwh'] = df['value'] / 1000.0
    
    # Add useful columns for the dashboard
    df['year'] = df['datetime'].dt.year
    df['month'] = df['datetime'].dt.month
    df['day'] = df['datetime'].dt.day
    df['hour'] = df['datetime'].dt.hour
    df['day_of_week'] = df['datetime'].dt.dayofweek # Monday=0, Sunday=6
    df['is_weekend'] = df['day_of_week'] >= 5
    df['date'] = df['datetime'].dt.date
    
    # Sort chronologically just in case
    df = df.sort_values('datetime').reset_index(drop=True)
    
    return df

if __name__ == "__main__":
    # Quick test to ensure parsing works
    df = parse_green_button_xml("/mnt/g/projects/electricity/electricit2024-now.xml")
    print(f"Successfully parsed {len(df)} records.")
    if not df.empty:
        print(df.head())
