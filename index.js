export const name = 'dsh-updater'

export function apply(ctx, config) {
  ctx.logger.info('dsh-updater loaded, checkOnStart=%s', config.checkOnStart)
}
