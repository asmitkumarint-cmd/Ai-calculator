/** Match the reference asset's `classifier:` field in a query embedding. */
export function withRestaurantClassifier(parts, classifier) {
  if (!classifier) return parts;
  const result = [...parts];
  const classifierPart = `classifier: ${classifier}`;
  const index = result.findIndex((part) => part.startsWith("classifier: "));
  if (index < 0) result.push(classifierPart);
  else result[index] = classifierPart;
  return result;
}
