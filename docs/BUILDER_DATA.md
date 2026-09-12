# Design collections and relationships

Open an app in Builder and choose **Data**. The diagram, collection editor and
seed-data table describe the data that travels with the exported `.softn` app.

## Connect collections

1. Add your collections with **Add Entity** and give them names and fields.
2. Drag a connector on the right of a collection to the left connector of another
   collection. You can also use **Add relationship** and choose both collections.
3. Choose the relationship type and save. The **Relationships** panel lets you
   select, edit or remove each link; clicking a diagram line opens its settings.

| Type | Example | Record storage |
| --- | --- | --- |
| One to one | A profile belongs to one customer | Optional reference field on the source |
| Many to one | Many orders belong to one customer | Optional reference field on each order |
| One to many | A customer has many orders | Draw the model, or reverse it to store a reference on orders |
| Many to many | Students take several courses | Use a linking collection with references to students and courses |

Cardinality describes the model. Your app logic controls validation and any
uniqueness or cascading behavior; drawing a line does not enforce those rules.

## Link real records

For a many-to-one or one-to-one relationship, choose an existing string/reference
field or **Create reference field…**. For example, connect `orders` to `customers`
and create `customerId` on `orders`. Dragging from a field connector preselects
that field. Choosing **Diagram only** leaves the fields and data unchanged.

Add sample customer records in **Seed Data**, then select a customer from the
`customerId` dropdown in an order. The stored value is the customer's record ID,
which stays stable when the app is exported and reopened. Configuring a reference
in the collection editor also adds its diagram connection.

## Save and refine the model

**Save** or **Export .softn** includes the collections, seed records, diagram
positions and relationships. Reopening that app in Builder restores the model.
The diagram metadata lives in `manifest.builder.schema`; record references live
in the collection's fields and values.

Removing a diagram relationship keeps its reference field and existing values.
Deleting a field removes its connections. Renaming a collection or field updates
the data model, but references in your `.ui` and `.logic` source need to be updated
manually. Invalid or duplicate names are reported before records are changed.

Use **Fit View** to see the whole diagram, or pan and zoom to inspect a larger
model. **Add relationship** and the **Relationships** panel provide alternatives
to dragging. Delete or Backspace acts on a selected item only while the diagram
has focus; it does not act through a relationship dialog or a data-entry control.
