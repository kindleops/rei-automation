/**
 * Reference coordinates for the places named in the imported plans.
 *
 * DISPLAY ONLY: approximate WGS84 city centres / county interiors, rounded to
 * 0.01° (~1 km), used for nothing except placing a planned-territory marker on
 * the globe. No measure is derived from a coordinate. A place missing here is
 * still listed everywhere; the globe reports it as "not placed" rather than
 * guessing a position.
 *
 * States are not listed: their label points are derived from the Census state
 * outlines already shipped at /geo/us-states.json (see domain/geography.ts).
 *
 * Keyed `${name}|${stateCode}` with the exact name the snapshot carries.
 */
export const PLACE_COORDINATES: Readonly<Record<string, readonly [lat: number, lng: number]>> = {
  // cities
  'Albany|NY': [42.65, -73.76], 'Albuquerque|NM': [35.08, -106.65], 'Alpharetta|GA': [34.08, -84.29], 'Ann Arbor|MI': [42.28, -83.74],
  'Athens|GA': [33.96, -83.38], 'Atlanta|GA': [33.75, -84.39], 'Atlantic City|NJ': [39.36, -74.42], 'Augusta|GA': [33.47, -81.97],
  'Aurora|CO': [39.73, -104.83], 'Austin|TX': [30.27, -97.74], 'Bellevue|WA': [47.61, -122.2], 'Boca Raton|FL': [26.37, -80.13],
  'Boston|MA': [42.36, -71.06], 'Boynton Beach|FL': [26.53, -80.09], 'Buffalo|NY': [42.89, -78.88], 'Cambridge|MA': [42.37, -71.11],
  'Charleston|SC': [32.78, -79.93], 'Charlotte|NC': [35.23, -80.84], 'Chattanooga|TN': [35.05, -85.31], 'Chicago|IL': [41.88, -87.63],
  'Colorado Springs|CO': [38.83, -104.82], 'Columbia|SC': [34.0, -81.03], 'Columbus|GA': [32.46, -84.99], 'Dallas|TX': [32.78, -96.8],
  'Denver|CO': [39.74, -104.99], 'Detroit|MI': [42.33, -83.05], 'Dunwoody|GA': [33.95, -84.33], 'El Paso|TX': [31.76, -106.49],
  'Eugene|OR': [44.05, -123.09], 'Fayetteville|AR': [36.06, -94.16], 'Fort Collins|CO': [40.59, -105.08], 'Fort Lauderdale|FL': [26.12, -80.14],
  'Fort Wayne|IN': [41.08, -85.14], 'Grand Rapids|MI': [42.96, -85.67], 'Greenville|SC': [34.85, -82.4], 'Harrisburg|PA': [40.27, -76.88],
  'Hialeah|FL': [25.86, -80.28], 'Hillsboro|OR': [45.52, -122.99], 'Houston|TX': [29.76, -95.37], 'Indianapolis|IN': [39.77, -86.16],
  'Jacksonville|FL': [30.33, -81.66], 'Jersey City|NJ': [40.73, -74.08], 'Kansas City|KS': [39.11, -94.63], 'Kansas City|MO': [39.1, -94.58],
  'Knoxville|TN': [35.96, -83.92], 'Lancaster|PA': [40.04, -76.31], 'Lansing|MI': [42.73, -84.56], 'Las Vegas|NV': [36.17, -115.14],
  'Lexington|KY': [38.04, -84.5], 'Little Rock|AR': [34.75, -92.29], 'Los Angeles|CA': [34.05, -118.24], 'Louisville|KY': [38.25, -85.76],
  'Macon|GA': [32.84, -83.63], 'Memphis|TN': [35.15, -90.05], 'Miami Beach|FL': [25.79, -80.13], 'Miami Gardens|FL': [25.94, -80.25],
  'Miami Lakes|FL': [25.91, -80.31], 'Miami Shores|FL': [25.86, -80.19], 'Miami|FL': [25.76, -80.19], 'Minneapolis|MN': [44.98, -93.27],
  'Myrtle Beach|SC': [33.69, -78.89], 'Nashville|TN': [36.16, -86.78], 'New York City|NY': [40.71, -74.01], 'Newark|NJ': [40.74, -74.17],
  'North Miami Beach|FL': [25.93, -80.16], 'North Miami|FL': [25.89, -80.19], 'Oakland|CA': [37.8, -122.27], 'Olympia|WA': [47.04, -122.9],
  'Orlando|FL': [28.54, -81.38], 'Palm Beach Gardens|FL': [26.82, -80.14], 'Philadelphia|PA': [39.95, -75.17], 'Phoenix|AZ': [33.45, -112.07],
  'Pittsburgh|PA': [40.44, -79.99], 'Portland|OR': [45.52, -122.68], 'Rochester|NY': [43.16, -77.61], 'Sacramento|CA': [38.58, -121.49],
  'Salem|MA': [42.52, -70.9], 'Salem|OR': [44.94, -123.04], 'San Antonio|TX': [29.42, -98.49], 'San Diego|CA': [32.72, -117.16],
  'San Francisco|CA': [37.77, -122.42], 'San Jose|CA': [37.34, -121.89], 'Sandy Springs|GA': [33.92, -84.38], 'Santa Fe|NM': [35.69, -105.94],
  'Savannah|GA': [32.08, -81.09], 'Seattle|WA': [47.61, -122.33], 'South Fulton|GA': [33.59, -84.56], 'South Miami|FL': [25.71, -80.29],
  'Spokane|WA': [47.66, -117.43], 'St. Louis|MO': [38.63, -90.2], 'Stonecrest|GA': [33.71, -84.13], 'Tacoma|WA': [47.25, -122.44],
  'Tampa|FL': [27.95, -82.46], 'Trenton|NJ': [40.22, -74.76], 'Tucker|GA': [33.85, -84.22], 'Vancouver|WA': [45.64, -122.66],
  'West Miami|FL': [25.76, -80.3], 'West Palm Beach|FL': [26.72, -80.05], 'Wichita|KS': [37.69, -97.34], 'Worcester|MA': [42.26, -71.8],
  // counties (interior points)
  'Bibb County|GA': [32.81, -83.7], 'Broward County|FL': [26.15, -80.45], 'Chatham County|GA': [32.0, -81.13], 'Cherokee County|GA': [34.24, -84.47],
  'Clarke County|GA': [33.95, -83.37], 'Clayton County|GA': [33.54, -84.36], 'Cobb County|GA': [33.94, -84.58], 'DeKalb County|GA': [33.77, -84.23],
  'Forsyth County|GA': [34.23, -84.13], 'Fulton County|GA': [33.79, -84.47], 'Gwinnett County|GA': [33.96, -84.02], 'Henry County|GA': [33.45, -84.15],
  'Miami Dade County|FL': [25.61, -80.5], 'Muscogee County|GA': [32.51, -84.87], 'Palm Beach County|FL': [26.65, -80.45], 'Richmond County|GA': [33.36, -82.07],
  // metros (principal city)
  'Atlanta metro|GA': [33.75, -84.39], 'Austin metro|TX': [30.27, -97.74], 'Dallas metro|TX': [32.78, -96.8], 'Miami metro|FL': [25.76, -80.19],
  'Inland Empire metro|CA': [34.0, -117.3],
}
