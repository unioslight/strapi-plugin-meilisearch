'use strict';
const Meilisearch = require('./client');

/**
 * Add one entry from a contentType to its index in Meilisearch.
 *
 * @param  {object} options
 * @param  {object} options.config - Configuration utililites.
 * @param  {object} options.adapter - Adapter utililites.
 * @param  {string} options.contentType - ContentType name.
 * @param  {object[] | object} options.entries - Entries to sanitize.
 * @returns {Promise<object[] | object>} - Sanitized entries.
 */
const sanitizeEntries = async function ({
  contentType,
  entries,
  config,
  adapter,
}) {
  if (!Array.isArray(entries)) entries = [entries];

  // remove un-published entries
  entries = await config.removeUnpublishedArticles({
    contentType,
    entries,
  });

  // remove entries with unwanted locale language
  entries = await config.removeLocaleEntries({
    contentType,
    entries,
  });

  // Apply filterEntry plugin config.
  entries = await config.filterEntries({
    contentType,
    entries,
  });

  // Remove sensitive fields (private = true)
  entries = await config.removeSensitiveFields({
    contentType,
    entries,
  });

  // Apply transformEntry plugin config.
  entries = await config.transformEntries({
    contentType,
    entries,
  });

  // Add content-type prefix to id
  entries = await adapter.addCollectionNamePrefix({
    contentType,
    entries,
  });

  return entries;
};

module.exports = ({ strapi, adapter, config }) => {
  const store = strapi.plugin('meilisearch').service('store');
  const contentTypeService = strapi
    .plugin('meilisearch')
    .service('contentType');
  const lifecycle = strapi.plugin('meilisearch').service('lifecycle');

  return {
    /**
     * Get index uids with a safe guard in case of error.
     *
     * @returns { Promise<import("meilisearch").Index[]> }
     */
    getIndexUids: async function () {
      try {
        const { apiKey, host } = await store.getCredentials();
        const client = Meilisearch({ apiKey, host });
        const { indexes } = await client.getStats();
        return Object.keys(indexes);
      } catch (e) {
        strapi.log.error(`meilisearch: ${e.message}`);
        return [];
      }
    },

    /**
     * Delete multiples entries from the contentType in its index in Meilisearch.
     *
     * @param  {object} options
     * @param  {string} options.contentType - ContentType name.
     * @param  {number[]} options.entriesId - Entries id.
     *
     * @returns  { Promise<import("meilisearch").Task>} p - Task body returned by Meilisearch API.
     */
    deleteEntriesFromMeiliSearch: async function ({ contentType, entriesId }) {
      const { apiKey, host } = await store.getCredentials();
      const client = Meilisearch({ apiKey, host });

      const indexUids = config.getIndexNamesOfContentType({ contentType });
      const documentsIds = entriesId.map((entryId) =>
        adapter.addCollectionNamePrefixToId({ entryId, contentType })
      );

      const tasks = await Promise.all(
        indexUids.map(
          async (indexUid) =>
            await client.index(indexUid).deleteDocuments(documentsIds)
        )
      );

      strapi.log.info(
        `A task to delete ${
          documentsIds.length
        } documents of the indexes "${indexUids.join(
          ', '
        )}" in Meilisearch has been enqueued (Task uids: ${tasks
          .map((task) => task.taskUid)
          .join(', ')}).`
      );

      return tasks;
    },

    /**
     * Update entries from the contentType in its index in Meilisearch.
     *
     * @param  {object} options
     * @param  {string} options.contentType - ContentType name.
     * @param  {object[]} options.entries - Entries to update.
     *
     * @returns  { Promise<void> }
     */
    updateEntriesInMeilisearch: async function ({ contentType, entries }) {
      const { apiKey, host } = await store.getCredentials();
      const client = Meilisearch({ apiKey, host });

      if (!Array.isArray(entries)) entries = [entries];

      const indexUids = config.getIndexNamesOfContentType({ contentType });
      await entries.forEach(async (entry) => {
        const sanitized = await sanitizeEntries({
          entries: [entry],
          contentType,
          config,
          adapter,
        });
        
        if (sanitized.length === 0) {
          return await Promise.all(
            indexUids.map(async (indexUid) => {
              const task = await client.index(indexUid).deleteDocument(
                adapter.addCollectionNamePrefixToId({
                  contentType,
                  entryId: entry.id,
                })
              );
              strapi.log.info(
                `A task to delete one document from the Meilisearch indexes "${indexUids.join(
                  ', '
                )}" has been enqueued (Task uid: ${task.taskUid}).`
              );
              return task;
            })
          );
        } else {
          return await Promise.all(
            indexUids.map(async (indexUid) => {
              const task = await client
                .index(indexUid)
                .updateDocuments(sanitized, { primaryKey: '_meilisearch_id' });
              strapi.log.info(
                `A task to update ${sanitized.length} document/s in the Meilisearch indexes "${indexUids.join(
                  ', '
                )}" has been enqueued (Task uid: ${task.taskUid}).`
              );
              return task;
            })
          );
        }
      });
    },

    /**
     * Get stats of an index with a safe guard in case of error.
     *
     * @param  {object} options
     * @param { string } options.indexUid
     *
     * @returns {Promise<import("meilisearch").IndexStats> }
     */
    getStats: async function ({ indexUid }) {
      try {
        const { apiKey, host } = await store.getCredentials();
        const client = Meilisearch({ apiKey, host });
        return await client.index(indexUid).getStats();
      } catch (e) {
        return {
          numberOfDocuments: 0,
          isIndexing: false,
          fieldDistribution: {},
        };
      }
    },

    buildReport: async function (
      indexUid,
      indexUids,
      listenedContentTypes,
      indexedContentTypes,
      contentType
    ) {
      const indexInMeiliSearch = indexUids.includes(indexUid);

      const contentTypeInIndexStore = indexedContentTypes.includes(contentType);
      const indexed = indexInMeiliSearch && contentTypeInIndexStore;

      const collectionName = contentTypeService.getCollectionName({
        contentType,
      });

      // safe guard in case index does not exist anymore in Meilisearch
      if (!indexInMeiliSearch && contentTypeInIndexStore) {
        await store.removeIndexedContentType({ contentType });
      }

      const { numberOfDocuments = 0, isIndexing = false } = indexUids.includes(
        indexUid
      )
        ? await this.getStats({ indexUid: indexUid })
        : {};

      const contentTypesWithSameIndexUid = await config.listContentTypesWithCustomIndexName(
        { indexName: indexUid }
      );
      const numberOfEntries = await contentTypeService.totalNumberOfEntries({
        contentTypes: contentTypesWithSameIndexUid,
      });

      return {
        collection: collectionName,
        contentType: contentType,
        indexUid: indexUid,
        indexed,
        isIndexing,
        numberOfDocuments,
        numberOfEntries,
        listened: listenedContentTypes.includes(contentType),
      };
    },

    /**
     * Information about contentTypes in Meilisearch.
     *
     * @returns {Promise<{ contentTypes: Array<{
     * contentType: string,
     * indexUid: string,
     * indexed: boolean,
     * isIndexing: boolean,
     * numberOfDocuments: number,
     * numberOfEntries: number,
     * listened: boolean,
     * }>}>} - List of contentTypes reports.
     */
    getContentTypesReport: async function () {
      const meilisearchIndexUids = await this.getIndexUids();

      // All listened contentTypes
      const listenedContentTypes = await store.getListenedContentTypes();
      // All indexed contentTypes
      const indexedContentTypes = await store.getIndexedContentTypes();

      const contentTypes = contentTypeService.getContentTypesUid();

      const reports = await Promise.all(
        contentTypes.map(async (contentType) => {
          const thisIndexUids = config.getIndexNamesOfContentType({
            contentType,
          });
          return await Promise.all(
            thisIndexUids.map(
              async (indexUid) =>
                await this.buildReport(
                  indexUid,
                  meilisearchIndexUids,
                  listenedContentTypes,
                  indexedContentTypes,
                  contentType
                )
            )
          );
        })
      );
      return { contentTypes: reports.flat() };
    },

    /**
     * Add entries from a contentType to its index in Meilisearch.
     *
     * @param  {object} options
     * @param  {string} options.contentType - ContentType name.
     * @param  {object[] | object} options.entries - Entry from the document.
     * @returns {Promise<Array<{ taskUid: number }>>} - Task identifier.
     */
    addEntriesToMeilisearch: async function ({ contentType, entries }) {
      const { apiKey, host } = await store.getCredentials();
      const client = Meilisearch({ apiKey, host });

      if (!Array.isArray(entries)) entries = [entries];

      const indexUids = config.getIndexNamesOfContentType({ contentType });
      const documents = await sanitizeEntries({
        contentType,
        entries,
        config,
        adapter,
      });

      const tasks = await Promise.all(
        indexUids.map(
          async (indexUid) =>
            await client
              .index(indexUid)
              .addDocuments(documents, { primaryKey: '_meilisearch_id' })
        )
      );
      await store.addIndexedContentType({ contentType }); //TODO: Is this array of index compatible?

      strapi.log.info(
        `The task to add ${
          documents.length
        } documents to the Meilisearch indexes "${indexUids.join(
          ', '
        )}" has been enqueued (Task uids: ${tasks
          .map((task) => task.taskUid)
          .join(', ')}).`
      );

      return tasks;
    },

    /**
     * Add all entries from a contentType to its index in Meilisearch.
     *
     * @param  {object} options
     * @param  {string} options.contentType - ContentType name.
     *
     * @returns {Promise<number[]>} - All task uids from the batched indexation process.
     */
    addContentTypeInMeiliSearch: async function ({ contentType }) {
      const { apiKey, host } = await store.getCredentials();
      const client = Meilisearch({ apiKey, host });
      const indexUids = config.getIndexNamesOfContentType({ contentType });

      // Get Meilisearch Index settings from model
      const tasks = await Promise.all(
        indexUids.map(async (indexUid) => {
          const settings = config.getSettings({ contentType, indexUid });
          const task = await client.index(indexUid).updateSettings(settings);
          return task;
        })
      );

      strapi.log.info(
        `A task to update the settings to the Meilisearch indexes "${indexUids.join(
          ', '
        )}" has been enqueued (Task uids: ${tasks
          .map((task) => task.taskUid)
          .join(', ')}).`
      );

      // Callback function for batching action
      const addDocuments = async ({ entries, contentType }) => {
        // Sanitize entries
        const documents = await sanitizeEntries({
          contentType,
          entries,
          config,
          adapter,
        });

        // Add documents in Meilisearch
        const tasks = await Promise.all(
          indexUids.map(
            async (indexUid) =>
              await client
                .index(indexUid)
                .addDocuments(documents, { primaryKey: '_meilisearch_id' })
          )
        );
        strapi.log.info(
          `A task to add ${
            documents.length
          } documents to the Meilisearch index "${indexUids.join(
            ', '
          )}" has been enqueued (Task uids: ${tasks
            .map((task) => task.taskUid)
            .join(', ')}).`
        );
        return tasks.map((task) => task.taskUid);
      };

      const tasksUids = await contentTypeService.actionInBatches({
        contentType,
        callback: addDocuments,
        entriesQuery: config.entriesQuery({ contentType }),
      });

      await store.addIndexedContentType({ contentType });
      await lifecycle.subscribeContentType({ contentType });

      return tasksUids;
    },

    /**
     * Search for the list of all contentTypes that share the same index name.
     *
     * @param  {object} options
     * @param  {string} options.contentType - ContentType name.
     *
     * @returns {Promise<string[]>} - ContentTypes names.
     */
    getContentTypesWithSameIndex: async function ({ contentType }) {
      const indexUids = config.getIndexNamesOfContentType({ contentType });

      // Fetch contentTypes that has the same indexName as the provided contentType
      const _contentTypesWithSameIndex = await Promise.all(
        indexUids.map(
          async (indexUid) =>
            await config
              .listContentTypesWithCustomIndexName({ indexName: indexUid })
              .map(
                (contentTypeName) =>
                  `api::${contentTypeName}.${contentTypeName}`
              )
        )
      );
      const contentTypesWithSameIndex = Array.from(
        new Set(_contentTypesWithSameIndex.flat())
      );

      // get all contentTypes (not indexes) indexed in Meilisearch.
      const indexedContentTypes = await store.getIndexedContentTypes();

      // Take union of both array
      const indexedContentTypesWithSameIndex = indexedContentTypes.filter(
        (contentType) => contentTypesWithSameIndex.includes(contentType)
      );

      return indexedContentTypesWithSameIndex;
    },

    /**
     * Delete or empty an index depending if the contentType is part
     * of a composite index.
     *
     * @param  {object} options
     * @param  {string} options.contentType - ContentType name.
     */
    emptyOrDeleteIndex: async function ({ contentType }) {
      const indexedContentTypesWithSameIndex = await this.getContentTypesWithSameIndex(
        {
          contentType,
        }
      );
      console.log(
        'indexedContentTypesWithSameIndex: ',
        indexedContentTypesWithSameIndex
      );
      // if (indexedContentTypesWithSameIndex.length > 1) {
      const deleteEntries = async ({ entries, contentType }) => {
        await this.deleteEntriesFromMeiliSearch({
          contentType,
          entriesId: entries.map((entry) => entry.id),
        });
      };

      await contentTypeService.actionInBatches({
        contentType,
        callback: deleteEntries,
        entriesQuery: config.entriesQuery({ contentType }),
      });
      // }
      //Unios - don't want to delete any indexes automatically via plugin
      // else {
      //   const { apiKey, host } = await store.getCredentials();
      //   const client = Meilisearch({ apiKey, host });

      //   const indexUid = config.getIndexNamesOfContentType({ contentType });

      //   await client.index(indexUid).delete();
      // }

      await store.removeIndexedContentType({ contentType });
    },

    /**
     * Update all entries from a contentType to its index in Meilisearch.
     *
     * @param  {object} options
     * @param  {string} options.contentType - ContentType name.
     *
     * @returns {Promise<number[]>} - All tasks uid from the indexation process.
     */
    updateContentTypeInMeiliSearch: async function ({ contentType }) {
      const indexedContentTypes = await store.getIndexedContentTypes();
      if (indexedContentTypes.includes(contentType)) {
        await this.emptyOrDeleteIndex({ contentType });
      }
      return this.addContentTypeInMeiliSearch({ contentType });
    },
  };
};
