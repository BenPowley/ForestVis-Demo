/*
 * Copyright (c) 2015-2018, IGN France.
 * Copyright (c) 2018-2025, Giro3D team.
 * SPDX-License-Identifier: MIT
 * This file was part of the Giro3D project, but changes were made from the original.
 * Original (Giro3D v0.43.5): https://gitlab.com/giro3d/giro3d/-/blob/v0.43.5/src/sources/las/filter.ts
 * Full license text in THIRD_PARTY_LICENSES.txt
 *
 * Modifications for ForestVis:
 * Copyright (c) 2026 Benjamin T. Powley, Petra Horváth, Claudio D. G. Linhares
 * Licensed under the MIT License; see LICENSE.txt in the project root.
 */

import type { View } from 'copc';

import type { DimensionName } from './dimension';

/**
 * Descriptor for filter behavior
 */
export interface FilterDescriptor {
    /**
     * If true, apply OR logic to this filter and all subsequent filters until the end of the array
     */
    useOrLogic?: boolean;
}

// A dimension filter wrapped into an index accessor with optional descriptor.
/** @internal */
export type FilterByIndex = ((index: number) => boolean) & { descriptor?: FilterDescriptor };

export type FilterOperator =
    | 'equal'
    | 'less'
    | 'lessequal'
    | 'greater'
    | 'greaterequal'
    | 'not'
    | 'in'
    | 'not_in';

/**
 * A filter that can be applied to dimensions to filter out unwanted points during processing.
 */
export type DimensionFilter =
    | {
          /**
           * The dimension this filter applies to.
           * If this dimension is not present in the source, the filter is ignored.
           */
          dimension: DimensionName;
          /**
           * The operator of the predicate to apply to a specific dimension value.
           */
          operator: Exclude<FilterOperator, 'in' | 'not_in' >;
          /**
           * The value to apply the predicate to.
           */
          value: number;
          /**
           * Optional descriptor for filter behavior
           */
          descriptor?: FilterDescriptor;
      }
    | {
          /**
           * The dimension this filter applies to.
           * If this dimension is not present in the source, the filter is ignored.
           */
          dimension: DimensionName;
          /**
           * The operator of the predicate to apply to a specific dimension value.
           */
          operator: Extract<FilterOperator, 'in' | 'not_in'>;
          /**
           * The values to apply the predicate to.
           */
          values: Set<number>;
          /**
           * Optional descriptor for filter behavior
           */
          descriptor?: FilterDescriptor;
      };

/**
 * For a given point index, evaluate all filters in series. 
 * Returns `true` if all AND filters return `true` and at least one OR filter returns `true` (if OR filters exist).
 * 
 * When an 'or' operator or useOrLogic descriptor is encountered, all subsequent filters are evaluated with OR logic.
 */
export function evaluateFilters(filters: FilterByIndex[] | null, pointIndex: number): boolean {
    if (filters == null || filters.length === 0) {
        return true;
    }

    let orStartIndex = filters.findIndex(f => f.descriptor?.useOrLogic === true);
    if (orStartIndex === -1) {
        // No OR logic, use default AND behavior
        const result = filters.every(f => f(pointIndex));
        return result;
    }

    // Evaluate AND filters (before OR starts)
    const andFilters = filters.slice(0, orStartIndex);
    if (andFilters.length > 0 && !andFilters.every(f => f(pointIndex))) {
        return false;
    }

    // Evaluate OR filters (from OR start to end)
    const orFilters = filters.slice(orStartIndex);
    if (orFilters.length > 0) {
        const result = orFilters.some(f => f(pointIndex));
        return result;
    }

    return true;
}

export function createPredicateFromFilter(filter: DimensionFilter): (value: number) => boolean {
    const operator = filter.operator;

    switch (operator) {
        case 'equal':
            return x => x === filter.value;
        case 'less':
            return x => x < filter.value;
        case 'lessequal':
            return x => x <= filter.value;
        case 'greater':
            return x => x > filter.value;
        case 'greaterequal':
            return x => x >= filter.value;
        case 'not':
            return x => x !== filter.value;
        case 'in':
            return x => filter.values.has(x);
        case 'not_in':
            return x => !filter.values.has(x);
        default:
            throw new Error(`invalid filter operator: '${operator}'`);
    }
}

/**
 * For a given set of dimension filters, return an array of ready-to-use functions to apply to each
 * point being read.
 */
export function getPerPointFilters(filters: DimensionFilter[], view: View): FilterByIndex[] | null {
    if (filters.length === 0) {
        return null;
    }
    const result: FilterByIndex[] = [];
    for (const filter of filters) {
        const predicate = createPredicateFromFilter(filter);
        if (view.dimensions[filter.dimension] != null) {
            const getter = view.getter(filter.dimension);
            const filterFn: FilterByIndex = (i: number): boolean => predicate(getter(i));
            
            // Attach descriptor if present
            if (filter.descriptor) {
                filterFn.descriptor = filter.descriptor;
            }
            
            result.push(filterFn);
        }
    }
    if (result.length > 0) {
        return result;
    }

    return null;
}
