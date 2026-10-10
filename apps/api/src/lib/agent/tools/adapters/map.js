// Map boundary — read tools (capability 1). Bounds counts only.
import { readTool, obj } from './_read-tool.js'

const coord = (min, max) => ({ type: 'number', minimum: min, maximum: max })

export const mapTools = [
  readTool({
    name: 'map.bounds_count',
    capability: 1,
    app: 'map',
    label: 'Counting properties in the map view',
    description: 'Property count inside a bounding box.',
    input_schema: obj({ west: coord(-180, 180), south: coord(-90, 90), east: coord(-180, 180), north: coord(-90, 90) }, ['west', 'south', 'east', 'north']),
    wraps: { module: '@/lib/domain/map/map-bounds-counts.js', export: 'countPropertiesInBounds', route: 'GET /api/cockpit/map/world' },
    to_model: ['count'],
    invoke: (fn, input, ctx) => {
      const client = ctx?.services?.db
      if (!client) {
        const e = new Error('map.bounds_count needs an injected read client')
        e.code = 'SERVICE_UNAVAILABLE'
        throw e
      }
      return fn(client, input)
    },
  }),
]
