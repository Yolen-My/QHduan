/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = app.findCollectionByNameOrId("pbc_7ix8hbthg69cue4")

  // update field
  collection.fields.addAt(2, new Field({
    "hidden": false,
    "id": "field_morbrvao42bxogx",
    "maxSelect": 1,
    "name": "office",
    "presentable": false,
    "required": true,
    "system": false,
    "type": "select",
    "values": [
      "北京",
      "上海",
      "深圳",
      "香港"
    ]
  }))

  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("pbc_7ix8hbthg69cue4")

  // update field
  collection.fields.addAt(2, new Field({
    "hidden": false,
    "id": "field_morbrvao42bxogx",
    "maxSelect": 1,
    "name": "office",
    "presentable": false,
    "required": true,
    "system": false,
    "type": "select",
    "values": [
      "北京",
      "上海",
      "深圳",
      "香港，东京"
    ]
  }))

  return app.save(collection)
})
