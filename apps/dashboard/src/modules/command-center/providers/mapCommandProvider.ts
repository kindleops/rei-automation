import { getStaticCommandRegistry } from '../command.registry'
import type { GlobalCommandProvider } from '../command.types'
import { limitResults, withScoredResult } from './providerUtils'

export const mapCommandProvider: GlobalCommandProvider = {
  id: 'map',
  search: async (query, context) => {
    const registry = getStaticCommandRegistry(context).filter((item) => item.type === 'map_action')
    if (!query.trim()) {
      return registry
        .sort((left, right) => right.score - left.score)
        .slice(0, 6)
    }
    return limitResults(registry.map((result) => withScoredResult(result, query, context)), 8)
  },
}
