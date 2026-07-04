/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = app.findCollectionByNameOrId("questions")

  // English title
  collection.fields.add(new Field({
    "autogeneratePattern": "",
    "hidden": false,
    "id": "text_title_en00",
    "max": 500,
    "min": 0,
    "name": "title_en",
    "pattern": "",
    "presentable": false,
    "primaryKey": false,
    "required": false,
    "system": false,
    "type": "text"
  }))

  // English options
  collection.fields.add(new Field({
    "hidden": false,
    "id": "json_options_en",
    "maxSize": 2000000,
    "name": "options_en",
    "presentable": false,
    "required": false,
    "system": false,
    "type": "json"
  }))

  // English correct answer
  collection.fields.add(new Field({
    "hidden": false,
    "id": "json_correct_en",
    "maxSize": 2000000,
    "name": "correctAnswer_en",
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
  collection.fields.removeById("json_correct_en")

  return app.save(collection)
})
