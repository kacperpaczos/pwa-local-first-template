type EntitySchema = { parse(data: unknown): unknown };

const registry = new Map<string, EntitySchema>();

export function registerEntitySchema(entity: string, schema: EntitySchema): void {
  if (registry.has(entity)) {
    throw new Error(`Entity schema already registered for "${entity}"`);
  }
  registry.set(entity, schema);
}

export function getEntitySchema(entity: string): EntitySchema | undefined {
  return registry.get(entity);
}
