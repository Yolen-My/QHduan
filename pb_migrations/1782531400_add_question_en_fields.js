/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = app.findCollectionByNameOrId("questions")

  // 英文标题（可选）
  collection.fields.add(new Field({
    "autogeneratePattern": "",
    "help": "",
    "hidden": false,
    "id": "text_title_en00",
    "max": 500,
    "min": 0,
    "name": "titleEn",
    "pattern": "",
    "presentable": false,
    "primaryKey": false,
    "required": false,
    "system": false,
    "type": "text"
  }))

  // 英文选项（可选，按索引与 options 对齐）
  collection.fields.add(new Field({
    "help": "",
    "hidden": false,
    "id": "json_options_en",
    "maxSize": 2000000,
    "name": "optionsEn",
    "presentable": false,
    "required": false,
    "system": false,
    "type": "json"
  }))

  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("questions")

  collection.fields.removeById("text_title_en00")
  collection.fields.removeById("json_options_en")

  return app.save(collection)
})
