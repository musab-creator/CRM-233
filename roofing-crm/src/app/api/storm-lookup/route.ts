import { NextRequest, NextResponse } from 'next/server';

// This API route simulates looking up storm events for a given location
// In production, this would query NOAA Storm Events Database, Hailstrike, or similar
export async function POST(request: NextRequest) {
  try {
    const { zipCode, startDate, endDate } = await request.json();

    if (!zipCode) {
      return NextResponse.json({ error: 'Zip code is required' }, { status: 400 });
    }

    // Simulate API call delay
    await new Promise(resolve => setTimeout(resolve, 1000));

    // In production, you would query:
    // 1. NOAA Storm Events Database (https://www.ncdc.noaa.gov/stormevents/)
    // 2. Hailstrike API for hail data
    // 3. National Weather Service storm reports
    // 4. SPC (Storm Prediction Center) severe weather reports

    const events = [
      {
        id: 'noaa-001',
        date: '2026-03-12',
        type: 'hail',
        severity: 'severe',
        location: `Area near ${zipCode}`,
        hailSize: '1.75 inch',
        windSpeed: null,
        description: 'Severe hailstorm with quarter to golf ball sized hail. Widespread roof damage reported in the area.',
        source: 'NOAA Storm Events Database',
      },
      {
        id: 'noaa-002',
        date: '2026-02-28',
        type: 'wind',
        severity: 'moderate',
        location: `Area near ${zipCode}`,
        hailSize: null,
        windSpeed: '65 mph',
        description: 'Strong straight-line winds with gusts up to 65mph causing shingle and fascia damage.',
        source: 'NOAA Storm Events Database',
      },
    ];

    // Determine best date of loss recommendation
    const recommendation = {
      events,
      recommendedDateOfLoss: '2026-03-12',
      recommendedClaimType: 'hail',
      confidence: 0.95,
      reasoning: `The March 12, 2026 hailstorm produced 1.75" hail in the ${zipCode} area, which is the most significant recent storm event. This date provides the strongest basis for a damage claim with documented NOAA reports.`,
    };

    return NextResponse.json({ success: true, ...recommendation });
  } catch {
    return NextResponse.json({ error: 'Failed to lookup storm data' }, { status: 500 });
  }
}
