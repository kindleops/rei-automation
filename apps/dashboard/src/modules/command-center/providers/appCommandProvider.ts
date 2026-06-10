import { getStaticCommandRegistry } from '../command.registry'
import type { GlobalCommandProvider } from '.../../domain/command-center/command.types'
import { limitResults, withScoredResult } from './providerUtils'

export const appCommandProvider: GlobalCommandProvider = {
  id: 'app',
  search: async (query, context) => {
    const registry = getStaticCommandRegistry(context).filter((item) => item.type === 'app' || item.type === 'system_action' || item.type === 'pipeline')
    if (!query.trim()) {
      return registry
        .sort((left, right) => right.score - left.score)
        .slice(0, 8)
    }
    return limitResults(
      registry.map((result) => withScoredResult(result, query, context)),
      10,
    )
  },
}
