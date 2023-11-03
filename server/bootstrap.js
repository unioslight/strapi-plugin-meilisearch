'use strict'
/**
 * Add listeners to the collection indexed in Meilisearch.
 *
 * @param  {object} options
 * @param  {object} options.store - store service.
 * @param  {object} options.lifecycle - lifecycle service.
 */
async function subscribeToLifecycles({ lifecycle, store }) {
  const contentTypes = await store.getIndexedContentTypes()
  await store.emptyListenedContentTypes()
  let lifecycles
  for (const contentType of contentTypes) {
    lifecycles = await lifecycle.subscribeContentType({ contentType })
  }

  return lifecycles
}

/**
 * Removed collections that are not indexed in Meilisearch
 * from the indexed store list.
 *
 * @param  {object} options
 * @param  {object} options.store - store service.
 * @param  {object} options.contentTypeService - contentType service.
 * @param  {object} options.meilisearch -  meilisearch service.
 */
async function syncIndexedCollections({
  store,
  contentTypeService,
  meilisearch,
}) {
  const indexUids = await meilisearch.getIndexUids()
  // All indexed contentTypes
  const indexedContentTypes = await store.getIndexedContentTypes()
  const contentTypes = contentTypeService.getContentTypesUid()

  for (const contentType of contentTypes) {
    const indexUid = meilisearch.getIndexNamesOfContentType({ contentType })
    const indexInMeiliSearch = indexUids.includes(indexUid)
    const contentTypeInIndexStore = indexedContentTypes.includes(contentType)

    // Remove any collection that is not in Meilisearch anymore
    if (!indexInMeiliSearch && contentTypeInIndexStore) {
      await store.removeIndexedContentType({ contentType })
    }
  }
}

module.exports = async ({ strapi }) => {
  const store = strapi.plugin('meilisearch').service('store')
  const lifecycle = strapi.plugin('meilisearch').service('lifecycle')
  const meilisearch = strapi.plugin('meilisearch').service('meilisearch')
  const contentTypeService = strapi.plugin('meilisearch').service('contentType')

  // Sync credentials between store and plugin config file
  await store.syncCredentials()
  await syncIndexedCollections({
    store,
    contentTypeService,
    meilisearch,
  })
  await subscribeToLifecycles({
    lifecycle,
    store,
  })
}
