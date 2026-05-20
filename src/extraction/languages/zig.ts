/**
 * Zig language extractor (tree-sitter-zig, targets Zig 0.16+).
 *
 * Known limitation: comptime-generated types such as
 *   `fn Physics(comptime R: type) type { return struct { ... }; }`
 * are not resolvable at the tree-sitter level (requires full type inference).
 * Methods on such types are not extracted.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';

function hasPub(node: SyntaxNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)?.type === 'pub') return true;
  }
  return false;
}

function isConstDecl(node: SyntaxNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)?.type === 'const') return true;
  }
  return false;
}

/** Find the @import builtin_function node inside a variable_declaration's value. */
function findImportBuiltin(node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'builtin_function') {
      const bid = child.namedChild(0);
      if (bid?.text === '@import') return child;
    }
    // `const io = @import("std").io` — value is field_expression
    if (child.type === 'field_expression') {
      const obj = child.namedChild(0);
      if (obj?.type === 'builtin_function') {
        const bid = obj.namedChild(0);
        if (bid?.text === '@import') return obj;
      }
    }
  }
  return null;
}

/** Extract the module string from `@import("module")`. */
function extractImportModule(builtin: SyntaxNode, source: string): string | null {
  // builtin_function → arguments → string → string_content
  const args = builtin.namedChildren.find((c) => c.type === 'arguments');
  if (!args) return null;
  const str = args.namedChildren.find((c) => c.type === 'string');
  if (!str) return null;
  const content = str.namedChildren.find((c) => c.type === 'string_content');
  return content ? getNodeText(content, source) : null;
}

/**
 * Handle `variable_declaration` nodes.
 *
 * Zig uses variable_declaration as a container for structs, enums, error sets,
 * @import calls, and plain constants/variables:
 *   pub const Foo = struct { ... }
 *   pub const Color = enum { ... }
 *   pub const AppError = error { ... }
 *   const std = @import("std")
 *   pub const PI: f64 = 3.14
 */
function handleVariableDecl(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = node.namedChildren.find((c) => c.type === 'identifier');
  if (!nameNode) return true;
  const name = getNodeText(nameNode, ctx.source);

  const pub = hasPub(node);
  const isConst = isConstDecl(node);
  const visibility = pub ? ('public' as const) : ('private' as const);

  const structChild = node.namedChildren.find((c) => c.type === 'struct_declaration');
  const enumChild = node.namedChildren.find((c) => c.type === 'enum_declaration');
  const errorChild = node.namedChildren.find((c) => c.type === 'error_set_declaration');
  const importBuiltin = findImportBuiltin(node);

  if (structChild) {
    const structNode = ctx.createNode('struct', name, node, {
      visibility,
      isExported: pub,
    });
    if (structNode) {
      ctx.pushScope(structNode.id);
      for (let i = 0; i < structChild.namedChildCount; i++) {
        const child = structChild.namedChild(i);
        if (child) ctx.visitNode(child);
      }
      ctx.popScope();
    }
    return true;
  }

  if (enumChild) {
    const enumNode = ctx.createNode('enum', name, node, {
      visibility,
      isExported: pub,
    });
    if (enumNode) {
      ctx.pushScope(enumNode.id);
      for (let i = 0; i < enumChild.namedChildCount; i++) {
        const child = enumChild.namedChild(i);
        if (!child) continue;
        if (child.type === 'container_field') {
          // Enum members share the container_field node type with struct fields
          const memberName = child.childForFieldName('name');
          if (memberName) {
            ctx.createNode('enum_member', getNodeText(memberName, ctx.source), child);
          }
        } else {
          // Methods and nested types inside an enum
          ctx.visitNode(child);
        }
      }
      ctx.popScope();
    }
    return true;
  }

  if (errorChild) {
    // Error sets are modelled as enums; members are plain identifiers
    const enumNode = ctx.createNode('enum', name, node, {
      visibility,
      isExported: pub,
    });
    if (enumNode) {
      ctx.pushScope(enumNode.id);
      for (let i = 0; i < errorChild.namedChildCount; i++) {
        const child = errorChild.namedChild(i);
        if (child?.type === 'identifier') {
          ctx.createNode('enum_member', getNodeText(child, ctx.source), child);
        }
      }
      ctx.popScope();
    }
    return true;
  }

  if (importBuiltin) {
    const moduleName = extractImportModule(importBuiltin, ctx.source);
    if (moduleName) {
      const sig = getNodeText(node, ctx.source).trim().replace(/;$/, '');
      ctx.createNode('import', name, node, { signature: sig });
      const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
      if (parentId) {
        ctx.addUnresolvedReference({
          fromNodeId: parentId,
          referenceName: moduleName,
          referenceKind: 'imports',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
    }
    return true;
  }

  // Plain constant or variable (pub const PI: f64 = 3.14, var count: i32 = 0, etc.)
  const kind = isConst ? ('constant' as const) : ('variable' as const);
  ctx.createNode(kind, name, node, {
    visibility,
    isExported: pub,
  });
  return true;
}

/**
 * Handle `test_declaration` nodes.
 *   test "name" { ... }   → function node named after the string content
 *   test { ... }          → function node named "unnamed"
 */
function handleTestDecl(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const strNode = node.namedChildren.find((c) => c.type === 'string');
  const bodyNode = node.namedChildren.find((c) => c.type === 'block');

  let testName = 'unnamed';
  if (strNode) {
    const content = strNode.namedChildren.find((c) => c.type === 'string_content');
    if (content) testName = getNodeText(content, ctx.source);
  }

  const testNode = ctx.createNode('function', testName, node, {
    visibility: 'public',
    signature: `test "${testName}"`,
  });
  if (testNode && bodyNode) {
    ctx.pushScope(testNode.id);
    ctx.visitFunctionBody(bodyNode, testNode.id);
    ctx.popScope();
  }
  return true;
}

export const zigExtractor: LanguageExtractor = {
  // function_declaration covers both top-level functions and struct methods.
  // Methods are identified automatically when the struct node is on the scope stack.
  functionTypes: ['function_declaration'],
  classTypes: [],
  methodTypes: ['function_declaration'],
  interfaceTypes: [],
  // struct/enum types are handled via visitNode (they nest inside variable_declaration)
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: ['call_expression'],
  // Variables are handled via visitNode to detect struct/enum/import values
  variableTypes: [],
  // container_field covers struct fields (enum members are handled manually in visitNode)
  fieldTypes: ['container_field'],

  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'type',

  getSignature: (node, source) => {
    // Zig's parameters node has no field name — find by type
    const params = node.namedChildren.find((c) => c.type === 'parameters');
    const retType = getChildByField(node, 'type');
    if (!params) return undefined;
    let sig = getNodeText(params, source);
    if (retType) sig += ' ' + getNodeText(retType, source);
    return sig;
  },

  getVisibility: (node) => (hasPub(node) ? 'public' : 'private'),

  visitNode: (node, ctx) => {
    if (node.type === 'variable_declaration') return handleVariableDecl(node, ctx);
    if (node.type === 'test_declaration') return handleTestDecl(node, ctx);
    return false;
  },
};
