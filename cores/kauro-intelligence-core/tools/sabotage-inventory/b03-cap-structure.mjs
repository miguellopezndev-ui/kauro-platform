/**
 * Sabotage inventory — the B03-CAP-STRUCTURE lot: the structural capability
 * families (closure plan D3-CAP-01, 02, 03 and 09; review finding B03-R9).
 * A MAP_OBJECT stands only on file-level facts that decide the object, is
 * applied to the file its candidate covers, never puts two files in one
 * record mapping, and its task carries its own file's columns and nothing of
 * another file (the object channel); a SELECT_SEMANTIC_TYPE the full-data
 * shapes support is applied to its destination and one they contradict is
 * refused; a FIELD_MAPPING stays inside its record mapping's object; a
 * column no target can hold is UNMAPPED_HANDLING's question and Migration
 * Core's unmapped material is answered by what became of its column. Each
 * mutation sits in the code it guards; test/b03-cap-structure.test.ts kills
 * them (and, for the unmapped material, test/b03-accounting.test.ts too).
 * Same shape as core.mjs; ids are unique across the directory.
 */
export const MUTATIONS = [
  // D3-CAP-01: the facts decide, or the claim does not hold.
  { id: 'cap-map-object-without-fact', file: 'src/compiler/compiler.ts', from: 'const decides = chosen !== undefined && objectDecides(facts, chosen.object);', to: 'const decides = chosen !== undefined;', gate: 'a MAP_OBJECT whose headers name the chosen object no more often than another is PROPOSED: the claimed fact holds without deciding anything, and a tied file is mapped to either object' },
  { id: 'cap-object-applied-to-another-file', file: 'src/api/intelligence-core.ts', from: "const fileId = contracts.refs.fieldByRef.get(item.sourceFieldRef ?? '')?.fileId;", to: "const fileId = contracts.profileView.fields.find((field) => field.fileId !== contracts.refs.fieldByRef.get(item.sourceFieldRef ?? '')?.fileId)?.fileId;", gate: 'the object a MAP_OBJECT decided is applied to another file than the one its candidate covers: the tied file gets no record mapping and Migration Core never delivers its rows as that object' },
  { id: 'cap-object-scope-collapse-accepted', file: 'src/compiler/compiler.ts', from: "      else if (candidatesByRef.has(item.targetRef)) fail('OBJECT_SCOPE_COLLAPSE', 'FORBIDDEN_PROPOSAL');\n", to: '', gate: "an answer that names another file's candidate as the object of a file — two files in one record mapping — is not refused as OBJECT_SCOPE_COLLAPSE" },
  // D3-CAP-01, the object channel: an OBJECT_MAPPING task carries its own file's columns, and its facts are counted over them alone.
  { id: 'cap-object-candidate-spans-bundle', file: 'src/resolver/deterministic-resolver.ts', from: 'candidateType: DERIVED_CANDIDATE_TYPES.OBJECT, sourceRefs: fileFields.map((entry) => entry.fieldRef),', to: 'candidateType: DERIVED_CANDIDATE_TYPES.OBJECT, sourceRefs: profileView.fields.map((entry) => entry.fieldRef),', gate: "the OBJECT_MAPPING candidate of a file covers every column of the bundle: the task carries other files' headers and facts, and the object facts count them" },
  // D3-CAP-03: the accepted type reaches the destination Migration Core loads; a type the shapes contradict is refused by name.
  { id: 'cap-semantic-type-not-applied', file: 'src/api/intelligence-core.ts', from: "fields[at] = { ...current, semanticType: item.semanticType, onInvalid: 'PRESERVE' };", to: 'fields[at] = { ...current };', gate: 'an accepted SELECT_SEMANTIC_TYPE is recorded and never applied: Migration Core reads the column under its deterministic type and flags nothing' },
  { id: 'cap-semantic-type-contradicting-shape-accepted', file: 'src/compiler/compiler.ts', from: "if (semanticType !== null && !typeReadByShapes(field, semanticType)) fail('SEMANTIC_TYPE_CONTRADICTS_SHAPE', 'INVALID_SEMANTICS', true);", to: '/* sabotage */', gate: 'a semantic type no full-data shape of the column reads its values as is not refused as SEMANTIC_TYPE_CONTRADICTS_SHAPE' },
  // D3-CAP-02: a field's destination is a field of its own record mapping's object.
  { id: 'cap-target-of-another-object-accepted', file: 'src/compiler/compiler.ts', from: "if ((item.proposalType === 'MAP_FIELD' || item.proposalType === 'MAP_ENUM_VALUE') && recordObject !== null && destinationField !== null && destinationField !== '' && (destinationField.split('.')[0] ?? '').toUpperCase() !== recordObject) fail('TARGET_OF_ANOTHER_OBJECT', 'FORBIDDEN_PROPOSAL');", to: '/* sabotage */', gate: "a FIELD_MAPPING of a Contact column to a Company field the task offered another candidate is only repairable, never refused as TARGET_OF_ANOTHER_OBJECT" },
  // D3-CAP-09: a column no target can hold is asked about and stays in the accounting; the unmapped material on it is answered by its column.
  { id: 'cap-unmapped-column-not-asked', file: 'src/resolver/deterministic-resolver.ts', from: "      questions.push({ questionRef: `q_${digestOf(['unmapped', field.fieldRef]).slice(0, 16)}`, taskType: 'UNMAPPED_HANDLING',", to: "      void ({ questionRef: `q_${digestOf(['unmapped', field.fieldRef]).slice(0, 16)}`, taskType: 'UNMAPPED_HANDLING',", gate: "a column no target can hold drops out of the run's accounting: no question, no preservation, and the draft's preserved columns no longer match Migration Core's unmapped leftovers" },
  { id: 'cap-unmapped-material-unaccounted', file: 'src/planner/candidate-accounting.ts', from: "      else if (question !== undefined) follows.set(original.candidateRef, { kind: 'CANDIDATE', candidateRef: question });\n", to: '', gate: "Migration Core's unmapped material on a column the run preserves stays UNRESOLVED FAMILY_NOT_PLANNED: the accounting drops what became of its column" },
];
