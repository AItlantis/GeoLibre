import test from "node:test";
import assert from "node:assert/strict";
import { aggregateGroups, aggregateGroupFlows, animationPhase, barHeight, barSquare, barsGeoJson, beforeAfterBarsGeoJson, bellHeight, classifyValue, quantileBreaks, tabsEnabled, validateLegend, type LegendConfig } from "../src/_od/map-logic.ts";

test("group centroids are weighted by member trip volume and flows sum by group pair", () => {
  const zones = [{id:"a",name:"A",group:"g",lon:0,lat:0},{id:"b",name:"B",group:"g",lon:10,lat:0},{id:"c",name:"C",group:"h",lon:20,lat:0}];
  const flows = [{origin:"a",destination:"c",trips:9},{origin:"b",destination:"c",trips:1}];
  const groups = aggregateGroups(zones, flows);
  assert.equal(groups.find(x=>x.id==="g")?.lon, 1);
  assert.deepEqual(aggregateGroupFlows(flows,new Map([["a","g"],["b","g"],["c","h"]])),[{origin:"g",destination:"h",trips:10}]);
});

test("bar geometry and heights support log scale and cap", () => {
  assert.equal(barHeight(2000,3,4),4);
  assert.equal(barHeight(1000,3,4,true),3*Math.log(2));
  assert.equal(barHeight(-2,3,4),0);
  assert.equal(barSquare(0,0,30,24).length,5);
  assert.equal(barsGeoJson([{id:"x",name:"X",lon:0,lat:0,origins:12,destinations:8}],3,50).features.length,2);
  assert.equal(beforeAfterBarsGeoJson([{id:"x",name:"X",lon:0,lat:0,prodBefore:12,prodAfter:10,attrBefore:8,attrAfter:9}],3,50).features.length,4);
});

test("legend validates thresholds and supports quantile and manual classes", () => {
  const c: LegendConfig = {neutral:20,decrease:500,increase:700,scheme:"RdBu",classification:"manual",breaks:[100,250,500]};
  assert.equal(validateLegend(c),true);
  assert.equal(validateLegend({...c,neutral:500}),false);
  assert.equal(validateLegend({...c,decrease:10,increase:700}),false);
  assert.equal(classifyValue(-300,c),2);
  assert.deepEqual(quantileBreaks([1,2,3,4,5],3),[2,4]);
  assert.equal(classifyValue(4,{...c,classification:"quantile"},[1,2,3,4,5]),3);
});

test("bell profile, animation phase and mode tab availability", () => {
  assert.equal(bellHeight(0.5,100),100);
  assert.equal(bellHeight(0,100),0);
  assert.equal(animationPhase(1500,2,false),0);
  assert.equal(animationPhase(1500,2,true),0);
  assert.deepEqual(tabsEnabled(["before"]),{trips:true,beforeAfter:false,difference:false});
  assert.deepEqual(tabsEnabled(["before","after"]),{trips:true,beforeAfter:true,difference:true});
});
