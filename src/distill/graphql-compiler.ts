import { reflectGraphQL, type Capability, type Port, type Reflection, type SemType } from "../../vendor/rightclick-x/src/index.ts";
import { inferContextualSemType, singularizeNoun, type ExchangeAnalysis } from "./provenance.ts";

interface GqlTypeRef {
  kind: string;
  name: string | null;
  ofType?: GqlTypeRef | null;
}

interface GqlFieldDef {
  name: string;
  description: string | null;
  args: Array<{ name: string; description: string | null; defaultValue: string | null; type: GqlTypeRef }>;
  type: GqlTypeRef;
}

interface GqlFullType {
  kind: string;
  name: string;
  description: string | null;
  fields?: GqlFieldDef[] | null;
  inputFields?: Array<{ name: string; description: string | null; defaultValue: string | null; type: GqlTypeRef }> | null;
}

function scalarTypeRef(scalarName: string, nonNull = false): GqlTypeRef {
  const base: GqlTypeRef = { kind: "SCALAR", name: scalarName, ofType: null };
  return nonNull ? { kind: "NON_NULL", name: null, ofType: base } : base;
}

/** Parse a GraphQL type literal like `ID!`, `[String!]!`, `Int` into an Introspection TypeRef. */
function parseGraphQLTypeLiteral(raw: string): GqlTypeRef {
  const s = raw.trim();
  if (s.endsWith("!")) {
    return { kind: "NON_NULL", name: null, ofType: parseGraphQLTypeLiteral(s.slice(0, -1)) };
  }
  if (s.startsWith("[") && s.endsWith("]")) {
    return { kind: "LIST", name: null, ofType: parseGraphQLTypeLiteral(s.slice(1, -1)) };
  }
  const builtins = new Set(["String", "Int", "Float", "Boolean", "ID"]);
  return {
    kind: builtins.has(s) ? "SCALAR" : "SCALAR", // Unknown custom/input scalars stay SCALAR unless registered
    name: builtins.has(s) ? s : "String",
    ofType: null,
  };
}

function inferScalarNameFromValue(val: unknown, semType: SemType): string {
  if (typeof val === "boolean") return "Boolean";
  if (typeof val === "number") return Number.isInteger(val) ? "Int" : "Float";
  if (semType === "id" || semType.startsWith("id.")) return "ID";
  return "String";
}

function pascalCase(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, "_");
  const parts = cleaned.split(/_+/).filter(Boolean);
  const joined = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
  return /^[A-Za-z]/.test(joined) ? joined : `T${joined}`;
}

interface ParsedRootField {
  operation: "query" | "mutation";
  fieldName: string;
  /** fieldArgName -> { gqlType, sampleValue, varName? } */
  args: Map<string, { gqlType: string; sampleValue: unknown; varName?: string }>;
}

/**
 * Parse a live GraphQL wire request `{ query, variables }` to extract:
 *   - operation ("query" | "mutation")
 *   - root field name
 *   - field argument names mapped to declared variable types and runtime values
 */
function parseGraphQLWireRequest(
  queryText: string,
  variables: Record<string, unknown>,
): ParsedRootField | null {
  // Strip # comments
  const clean = queryText.replace(/#[^\r\n]*/g, " ").trim();
  const headerMatch = /^\s*(query|mutation)?\s*(?:[_A-Za-z][_0-9A-Za-z]*)?\s*(\([^)]*\))?\s*\{/i.exec(clean);
  if (!headerMatch) return null;

  const operation = (headerMatch[1]?.toLowerCase() === "mutation" ? "mutation" : "query") as "query" | "mutation";
  const varDecls = new Map<string, string>();
  if (headerMatch[2]) {
    const inner = headerMatch[2].slice(1, -1);
    for (const m of inner.matchAll(/\$([_A-Za-z][_0-9A-Za-z]*)\s*:\s*([[\]_A-Za-z0-9!]+)/g)) {
      varDecls.set(m[1]!, m[2]!);
    }
  }

  const afterBrace = clean.slice(headerMatch[0].length).trim();
  const rootMatch = /^(?:([_A-Za-z][_0-9A-Za-z]*)\s*:\s*)?([_A-Za-z][_0-9A-Za-z]*)\s*(\([^)]*\))?/.exec(afterBrace);
  if (!rootMatch) return null;

  const fieldName = rootMatch[2]!;
  if (fieldName.startsWith("__")) return null;

  const args = new Map<string, { gqlType: string; sampleValue: unknown; varName?: string }>();
  if (rootMatch[3]) {
    const callInner = rootMatch[3].slice(1, -1);
    // Match `argName: $varName` or `argName: "literal"` / `123` / `true`
    for (const m of callInner.matchAll(/([_A-Za-z][_0-9A-Za-z]*)\s*:\s*(\$[_A-Za-z][_0-9A-Za-z]*|"[^"]*"|-?\d+(?:\.\d+)?|true|false)/g)) {
      const argName = m[1]!;
      const rhs = m[2]!;
      if (rhs.startsWith("$")) {
        const varName = rhs.slice(1);
        const val = variables[varName];
        const declared = varDecls.get(varName);
        const sem = inferContextualSemType([argName], val);
        const fallbackGql = `${inferScalarNameFromValue(val, sem)}!`;
        args.set(argName, { gqlType: declared ?? fallbackGql, sampleValue: val, varName });
      } else if (rhs.startsWith('"')) {
        const lit = rhs.slice(1, -1);
        const sem = inferContextualSemType([argName], lit);
        args.set(argName, { gqlType: `${inferScalarNameFromValue(lit, sem)}!`, sampleValue: lit });
      } else if (rhs === "true" || rhs === "false") {
        args.set(argName, { gqlType: "Boolean!", sampleValue: rhs === "true" });
      } else {
        const num = Number(rhs);
        args.set(argName, { gqlType: Number.isInteger(num) ? "Int!" : "Float!", sampleValue: num });
      }
    }
  } else {
    // Fallback if variables were passed directly with matching names
    for (const [vk, vv] of Object.entries(variables)) {
      if (vv !== undefined && vv !== null && typeof vv !== "object") {
        const sem = inferContextualSemType([vk], vv);
        args.set(vk, {
          gqlType: varDecls.get(vk) ?? `${inferScalarNameFromValue(vv, sem)}!`,
          sampleValue: vv,
        });
      }
    }
  }

  return { operation, fieldName, args };
}

/**
 * Compile observed GraphQL wire exchanges (even when server introspection is 403/disabled!)
 * into a synthesized GraphQL __schema introspection document AND a RightClick X Reflection
 * with full deep semantic ports.
 */
export function compileGraphQLExchanges(
  endpoint: string,
  analyses: ExchangeAnalysis[],
  title?: string,
): { introspection: Record<string, unknown>; reflection: Reflection } | null {
  if (!analyses.length) return null;

  const objectTypes = new Map<string, Map<string, GqlFieldDef>>();
  const queryFields = new Map<string, GqlFieldDef>();
  const mutationFields = new Map<string, GqlFieldDef>();
  // operationKey -> deep ports discovered in responses
  const deepPortsByField = new Map<string, Port[]>();

  const buildValueType = (
    val: unknown,
    typePrefix: string,
    pathSegs: string[],
    rootNoun: string,
    depth: number,
  ): GqlTypeRef => {
    if (val === null || val === undefined || depth > 6) {
      return scalarTypeRef("String");
    }
    if (Array.isArray(val)) {
      const sample = val.find((x) => x !== null && x !== undefined);
      const inner = sample !== undefined
        ? buildValueType(sample, `${typePrefix}Item`, [...pathSegs, "0"], rootNoun, depth + 1)
        : scalarTypeRef("String");
      return { kind: "LIST", name: null, ofType: inner };
    }
    if (typeof val === "object") {
      const typeName = pascalCase(typePrefix);
      const fieldMap = objectTypes.get(typeName) ?? new Map<string, GqlFieldDef>();
      objectTypes.set(typeName, fieldMap);
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        if (!/^[_A-Za-z][_0-9A-Za-z]*$/.test(k) || k === "__typename") continue;
        const childSegs = [...pathSegs, k];
        const childType = buildValueType(v, `${typeName}_${k}`, childSegs, rootNoun, depth + 1);
        const isScalar = childType.kind === "SCALAR" || (childType.kind === "NON_NULL" && childType.ofType?.kind === "SCALAR");
        let desc: string | null = null;
        if (isScalar && v !== null && v !== undefined) {
          const sem = inferContextualSemType(childSegs, v, rootNoun);
          desc = `Observed ${k} [rightclick:${sem}]`;
        }
        if (!fieldMap.has(k)) {
          fieldMap.set(k, {
            name: k,
            description: desc,
            args: [],
            type: childType,
          });
        }
      }
      if (fieldMap.size === 0) {
        return scalarTypeRef("String");
      }
      return { kind: "OBJECT", name: typeName, ofType: null };
    }
    const sem = inferContextualSemType(pathSegs, val, rootNoun);
    return scalarTypeRef(inferScalarNameFromValue(val, sem));
  };

  for (const item of analyses) {
    const reqObj = (item.parsedRequestBody ?? {}) as Record<string, unknown>;
    const queryText = typeof reqObj.query === "string" ? reqObj.query : "";
    const vars =
      reqObj.variables && typeof reqObj.variables === "object" && !Array.isArray(reqObj.variables)
        ? (reqObj.variables as Record<string, unknown>)
        : {};
    const parsed = parseGraphQLWireRequest(queryText, vars);
    if (!parsed) continue;

    const resObj = (item.parsedResponseBody ?? {}) as Record<string, unknown>;
    const dataObj =
      resObj.data && typeof resObj.data === "object" && !Array.isArray(resObj.data)
        ? (resObj.data as Record<string, unknown>)
        : undefined;
    // Match either exact fieldName or first key in data (if aliased)
    const fieldPayload =
      dataObj && Object.hasOwn(dataObj, parsed.fieldName)
        ? dataObj[parsed.fieldName]
        : dataObj
          ? Object.values(dataObj)[0]
          : undefined;
    if (fieldPayload === undefined) continue;

    const rootNoun = singularizeNoun(parsed.fieldName);
    const returnType = buildValueType(
      fieldPayload,
      `${pascalCase(parsed.fieldName)}Result`,
      [],
      rootNoun,
      0,
    );

    const argDefs: GqlFieldDef["args"] = [];
    for (const [argName, info] of parsed.args.entries()) {
      const edgeHit = item.inboundEdges.find(
        (e) =>
          e.toParamName === argName ||
          (info.varName !== undefined &&
            (e.toParamName === info.varName || e.toParamName === `variables.${info.varName}`)),
      );
      const explicitArgSem = inferContextualSemType([argName], info.sampleValue, rootNoun);
      const sem = explicitArgSem.startsWith("id.") ? explicitArgSem : (edgeHit?.toSemType ?? explicitArgSem);
      argDefs.push({
        name: argName,
        description: `Input ${argName} [rightclick:${sem}]`,
        defaultValue: null,
        type: parseGraphQLTypeLiteral(info.gqlType),
      });
    }

    const targetMap = parsed.operation === "mutation" ? mutationFields : queryFields;
    const existing = targetMap.get(parsed.fieldName);
    if (!existing) {
      targetMap.set(parsed.fieldName, {
        name: parsed.fieldName,
        description: `Distilled live GraphQL ${parsed.operation} ${parsed.fieldName}`,
        args: argDefs,
        type: returnType,
      });
    } else {
      for (const a of argDefs) {
        if (!existing.args.some((ea) => ea.name === a.name)) existing.args.push(a);
      }
    }

    // Record deep output ports (relative to `data[fieldName]`) so nested array/object fields chain cleanly!
    const dataKey =
      dataObj && Object.hasOwn(dataObj, parsed.fieldName)
        ? parsed.fieldName
        : dataObj
          ? (Object.keys(dataObj)[0] ?? parsed.fieldName)
          : parsed.fieldName;
    const dataPrefix = `data.${dataKey}.`;
    const barePrefix = `${parsed.fieldName}.`;
    const stripRoot = (p: string): string => {
      if (p.startsWith(dataPrefix)) return p.slice(dataPrefix.length);
      if (p.startsWith(barePrefix)) return p.slice(barePrefix.length);
      return "";
    };
    const fieldKey = `${parsed.operation}:${parsed.fieldName}`;
    const deepPorts = deepPortsByField.get(fieldKey) ?? [];
    for (const leaf of item.producedLeaves) {
      const relScalar = stripRoot(leaf.portPath);
      if (relScalar && !deepPorts.some((p) => p.name === relScalar)) {
        deepPorts.push({ name: relScalar, type: leaf.semType, required: false });
      }
      if (leaf.listPortPath) {
        const relList = stripRoot(leaf.listPortPath);
        if (relList && relList !== relScalar && !deepPorts.some((p) => p.name === relList)) {
          deepPorts.push({ name: relList, type: `list:${leaf.semType}`, required: false });
        }
      }
    }
    deepPortsByField.set(fieldKey, deepPorts);
  }

  if (queryFields.size === 0 && mutationFields.size === 0) return null;

  const types: GqlFullType[] = [
    { kind: "SCALAR", name: "String", description: null },
    { kind: "SCALAR", name: "Int", description: null },
    { kind: "SCALAR", name: "Float", description: null },
    { kind: "SCALAR", name: "Boolean", description: null },
    { kind: "SCALAR", name: "ID", description: null },
  ];

  // Ensure Query exists even if only mutations were seen (GraphQL spec requires queryType)
  if (queryFields.size > 0 || mutationFields.size > 0) {
    types.push({
      kind: "OBJECT",
      name: "Query",
      description: "Distilled Query root",
      fields: [...queryFields.values()],
    });
  }
  if (mutationFields.size > 0) {
    types.push({
      kind: "OBJECT",
      name: "Mutation",
      description: "Distilled Mutation root",
      fields: [...mutationFields.values()],
    });
  }
  for (const [objName, fieldsMap] of objectTypes.entries()) {
    types.push({
      kind: "OBJECT",
      name: objName,
      description: null,
      fields: [...fieldsMap.values()],
    });
  }

  const introspection = {
    data: {
      __schema: {
        queryType: { name: "Query" },
        mutationType: mutationFields.size > 0 ? { name: "Mutation" } : null,
        types,
      },
    },
  };

  const reflection = reflectGraphQL(introspection, endpoint, title);
  // Attach deep provenance-backed ports that sit below depth 2 or across arrays
  for (const cap of reflection.capabilities) {
    if (cap.invoke.kind !== "graphql") continue;
    const extra = deepPortsByField.get(`${cap.invoke.operation}:${cap.invoke.field}`) ?? [];
    const existingNames = new Set(cap.outputs.map((o) => o.name));
    for (const p of extra) {
      if (!existingNames.has(p.name)) {
        cap.outputs.push(p);
        existingNames.add(p.name);
      }
    }
  }

  return { introspection, reflection };
}
