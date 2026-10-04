// Data files
const suburbsFile = "SAL_2021_AUST_GDA2020.json";
const eventsFile = "AusStage_events_1900_onwards.csv";

// The map's width (shared by the chart and legend) is the width of the page
// column holding the SVGs, so they line up with the text. Its height follows
// from the map's shape at that width.

// Class boundaries for a suburb's share of all events in the selected years
// (map legend). Shares range from ~0.01% to ~99%, so the classes grow roughly 5x.
const limits = [0.001, 0.005, 0.02, 0.1];
const formatShare = d3.format(".2~%");
const zeroColor = "#eee";

// Water layer and its label
const waterColor = "#c9e4ee"; // a paler lightblue (#add8e6)
const waterLabelColor = "#4a90b8";
const bayLabelPosition = [144.818, -38.063]; // [lon, lat]

// Zoom factor when clicking a suburb (1 = whole map), and animation length
const clickZoom = 3;
const zoomDuration = 750;

// Heading shared by the line chart and legend: a <g class="heading"> holding
// the title and subtitle (styled by .title and .subtitle in the CSS).
// headingHeight is the space they take from the top of the SVG; content starts
// headingMargin below that.
const headingHeight = 44;
const headingMargin = 10;

// Line chart size; the top margin leaves room for the heading
const chartHeight = 210;
const chartMargin = { top: headingHeight + headingMargin, right: 10, bottom: 38, left: 56 };

// Annotation on the line chart's peak: the box's text (built from the peak's
// year and count), and where the middle of the box's right edge sits relative
// to the peak, as [dx, dy] in pixels
const annotationText = peak =>
  `${peak.year} saw a peak in active events (${d3.format(",")(peak.count)})`;
const annotationOffset = [-150, 25];

// Selection window (default: centred in 2010)
const windowYears = 10;
const initialStartYear = 2005;

// Page elements
const tooltip = d3.select("#tooltip");
const svg = d3.select("#map");
const mapGroup = svg.append("g");

// Data preparation
// Assign each event to a suburb: find the suburb polygon containing each unique lat/lon point
function prepareEvents(rows, features) {
  const featureBounds = features.map(f => d3.geoBounds(f));
  const suburbByPoint = new Map();

  for (const key of new Set(rows.map(d => `${d.Longitude},${d.Latitude}`))) {
    const [lon, lat] = key.split(",").map(Number);
    suburbByPoint.set(key, features.findIndex((f, j) => {
      const [[bx0, by0], [bx1, by1]] = featureBounds[j];
      return lon >= bx0 && lon <= bx1 && lat >= by0 && lat <= by1
        && d3.geoContains(f, [lon, lat]);
    }));
  }

  return rows.map(d => ({
    firstYear: +d["First Year"],
    lastYear: +d["Last Year"],
    suburb: suburbByPoint.get(`${d.Longitude},${d.Latitude}`)
  }));
}

// Count events per suburb that were active at any time in startYear–endYear
// (inclusive), storing the result in each feature's properties.count, and the
// suburb's share of all those events (0–1) in properties.share
function countEvents(events, features, startYear, endYear) {
  features.forEach(f => f.properties.count = 0);
  for (const e of events) {
    if (e.suburb >= 0 && e.firstYear <= endYear && e.lastYear >= startYear) {
      features[e.suburb].properties.count++;
    }
  }
  const total = d3.sum(features, f => f.properties.count);
  features.forEach(f => f.properties.share = total ? f.properties.count / total : 0);
}

// Active events per year (events from prepareEvents): an event is active in
// every year from its first year to its last year inclusive (so an event
// starting and ending in the same year is active in that year). Years with no
// active events count as 0.
function activeEventsPerYear(events) {
  const minYear = d3.min(events, d => d.firstYear);
  const maxYear = d3.max(events, d => d.lastYear);
  const activeByYear = new Map(d3.range(minYear, maxYear + 1).map(year => [year, 0]));

  for (const d of events) {
    for (let year = d.firstYear; year <= d.lastYear; year++) {
      activeByYear.set(year, activeByYear.get(year) + 1);
    }
  }

  return Array.from(activeByYear, ([year, count]) => ({ year, count }));
}

// Map
// Draw the water, suburbs (with tooltip) and bay label; returns the suburbs
function drawMap(features, projection, path, width, height) {
  // Water: fill the whole SVG behind the suburbs.
  mapGroup.append("rect")
    .attr("width", width)
    .attr("height", height)
    .attr("fill", waterColor);

  const suburbs = mapGroup.selectAll("path")
    .data(features)
    .join("path")
    .attr("class", "suburb")
    .attr("d", path)
    // Tooltip: suburb name (without the " (Vic.)" suffix) and event count.
    .on("mouseover", (event, d) => {
      tooltip
        .style("display", "block")
        .text(tooltipText(d));
    })
    .on("mousemove", (event) => {
      tooltip
        .style("left", `${event.pageX + 12}px`)
        .style("top", `${event.pageY + 12}px`);
    })
    .on("mouseout", () => tooltip.style("display", "none"));

  // Water label, in a darker shade of the water colour
  const [bayX, bayY] = projection(bayLabelPosition);
  mapGroup.append("text")
    .attr("x", bayX)
    .attr("y", bayY)
    .attr("text-anchor", "middle")
    .attr("dominant-baseline", "middle")
    .attr("fill", waterLabelColor)
    .style("font", "italic 12px 'Open Sans', sans-serif")
    .style("pointer-events", "none")
    .text("Port Phillip Bay");

  return suburbs;
}

function tooltipText(d) {
  const name = d.properties.SAL_NAME21.replace(/ \(.*\)$/, "");
  const count = d.properties.count === 0
    ? "No events"
    : `Events: ${d3.format(",")(d.properties.count)} (${formatShare(d.properties.share)} of total)`;
  return `${name}\n${count}`;
}

function colourSuburbs(suburbs, color) {
  suburbs.attr("fill", d => d.properties.count === 0 ? zeroColor : color(d.properties.share));
}

// Zoom
// Click a suburb to zoom in by clickZoom, centred on it; double-click anywhere
// on the page to reset to the whole map. Zoom runs from 1 to clickZoom (depth).
function setupZoom(suburbs, path, width, height) {
  const extent = [[0, 0], [width, height]];

  const zoom = d3.zoom()
    .scaleExtent([1, clickZoom])
    .translateExtent(extent)
    .on("zoom", (event) => mapGroup.attr("transform", event.transform));

  svg.call(zoom).on(".zoom", null);

  suburbs.on("click", (event, d) => {
    const [cx, cy] = path.centroid(d);
    const centred = d3.zoomIdentity
      .translate(width / 2, height / 2)
      .scale(clickZoom)
      .translate(-cx, -cy);

    // When zooming in, keep the map filling the SVG for suburbs near the edges
    const clamped = zoom.constrain()(centred, extent, zoom.translateExtent());

    svg.transition()
      .duration(zoomDuration)
      .call(zoom.transform, clamped);
  });

  d3.select(document).on("dblclick", () => {
    svg.transition()
      .duration(zoomDuration)
      .call(zoom.transform, d3.zoomIdentity);
  });
}

// Line chart
// Line chart of active events per year
// Optional onRangeChange(startYear, endYear) is called with the selected years.
function drawChart(events, chartWidth, onRangeChange) {
  const margin = chartMargin;
  const data = activeEventsPerYear(events);
  const [minYear, maxYear] = d3.extent(data, d => d.year);

  const x = d3.scaleLinear()
    .domain([minYear, maxYear])
    .range([margin.left, chartWidth - margin.right]);

  const y = d3.scaleLinear()
    .domain([0, d3.max(data, d => d.count)])
    .nice()
    .range([chartHeight - margin.bottom, margin.top]);

  const chart = d3.select("#chart")
    .attr("width", chartWidth)
    .attr("height", chartHeight);

  addHeading(chart, `Active events per year, ${minYear}–${maxYear}`,
    "Drag they grey rectangle to change the map's time range (10 years).");

  chart.append("g")
    .attr("transform", `translate(0, ${chartHeight - margin.bottom})`)
    .call(d3.axisBottom(x).tickFormat(d3.format("d")));

  chart.append("g")
    .attr("transform", `translate(${margin.left}, 0)`)
    .call(d3.axisLeft(y).ticks(4).tickFormat(d3.format(",")));

  // X axis title
  chart.append("text")
    .attr("class", "axis-title")
    .attr("x", (margin.left + chartWidth - margin.right) / 2)
    .attr("y", chartHeight - 4)
    .attr("text-anchor", "middle")
    .text("Year");

  // Y axis title
  chart.append("text")
    .attr("class", "axis-title")
    .attr("transform", `translate(12, ${(margin.top + chartHeight - margin.bottom) / 2}) rotate(-90)`)
    .attr("text-anchor", "middle")
    .text("Events");

  chart.append("path")
    .datum(data)
    .attr("fill", "none")
    .attr("stroke", "darkred")
    .attr("stroke-width", 1.5)
    .attr("d", d3.line()
      .x(d => x(d.year))
      .y(d => y(d.count)));

  // Annotation first, so the selection window is drawn in front of it
  drawPeakAnnotation(chart, data, x, y);
  drawSelectionWindow(chart, x, minYear, maxYear, onRangeChange);
}

// Peak annotation: a small black circle on the year with the most active
// events, and a line from it to a text box styled like the tooltip.
function drawPeakAnnotation(chart, data, x, y) {
  const peak = d3.greatest(data, d => d.count);
  const px = x(peak.year);
  const py = y(peak.count);
  const [dx, dy] = annotationOffset;

  const annotation = chart.append("g")
    .attr("class", "peak-annotation")
    .style("pointer-events", "none");

  annotation.append("line")
    .attr("x1", px)
    .attr("y1", py)
    .attr("x2", px + dx)
    .attr("y2", py + dy)
    .attr("stroke", "black");

  // The HTML box goes in a foreignObject; measure it, then fit the foreignObject to it
  const box = annotation.append("foreignObject")
    .attr("width", chart.attr("width"))
    .attr("height", chartHeight);

  const div = box.append("xhtml:div")
    .attr("class", "annotation")
    .text(annotationText(peak));

  const { width, height } = div.node().getBoundingClientRect();
  box
    .attr("x", px + dx - width)
    .attr("y", py + dy - height / 2)
    .attr("width", width)
    .attr("height", height);

  annotation.append("circle")
    .attr("cx", px)
    .attr("cy", py)
    .attr("r", 3)
    .attr("fill", "black");
}

// Selection window: windowYears wide, the height of the plot area, and
// draggable left/right between the first and last year. It snaps to whole
// years and selects years startYear to startYear + windowYears - 1.
function drawSelectionWindow(chart, x, minYear, maxYear, onRangeChange) {
  const windowWidth = x(minYear + windowYears) - x(minYear);
  const minX = x(minYear);
  const maxX = x(maxYear) - windowWidth;
  let windowX = x(initialStartYear);
  let startYear = Math.round(x.invert(windowX));

  onRangeChange?.(startYear, startYear + windowYears - 1);

  chart.append("rect")
    .attr("class", "selection")
    .attr("x", x(startYear))
    .attr("y", chartMargin.top)
    .attr("width", windowWidth)
    .attr("height", chartHeight - chartMargin.top - chartMargin.bottom)
    .attr("fill", "grey")
    .attr("fill-opacity", 0.3)
    .style("cursor", "grab")
    .call(d3.drag()
      .on("start", function () { d3.select(this).style("cursor", "grabbing"); })
      .on("drag", function (event) {
        // Track the unsnapped position, and draw/filter by the nearest year
        windowX = Math.max(minX, Math.min(maxX, windowX + event.dx));
        const year = Math.round(x.invert(windowX));
        if (year === startYear) return;
        startYear = year;
        d3.select(this).attr("x", x(startYear));
        onRangeChange?.(startYear, startYear + windowYears - 1);
      })
      .on("end", function () { d3.select(this).style("cursor", "grab"); }));
}

// Legend
// Discrete legend in its own SVG above the map, the same width as the map.
function drawLegend(color, features, legendWidth) {
  const padding = 10;
  const barHeight = 14;
  const boundHeight = 14;
  const barWidth = legendWidth;
  const barY = headingHeight + headingMargin;
  const legendHeight = barY + barHeight + boundHeight + padding;

  // Events per class
  const classes = color.range().map((c, i) => {
    const next = limits[i];
    const events = d3.sum(features, f => color(f.properties.share) === c ? f.properties.count : 0);
    return { color: c, events, next };
  });
  const total = d3.sum(classes, d => d.events);

  // Stack the segments left to right
  const x = d3.scaleLinear().domain([0, total || 1]).range([0, barWidth]);
  let start = 0;
  classes.forEach(d => { d.start = start; start += d.events; });

  const legend = d3.select("#legend")
    .attr("width", legendWidth)
    .attr("height", legendHeight);

  legend.append("rect")
    .attr("width", legendWidth)
    .attr("height", legendHeight)
    .attr("fill", "white");

  // Title text is set by setLegendTitle (it shows the selected years)
  addHeading(legend, "", "Click on a suburb to zoom in. Double click anywhere to reset.", "legend-title");

  legend.selectAll("rect.segment")
    .data(classes)
    .join("rect")
    .attr("class", "segment")
    .attr("x", d => x(d.start))
    .attr("y", barY)
    .attr("width", d => x(d.events))
    .attr("height", barHeight)
    .attr("fill", d => d.color);

  // Class boundaries under the bar: at the right end of each segment
  legend.selectAll("text.bound")
    .data(classes.slice(0, -1))
    .join("text")
    .attr("class", "bound")
    .attr("x", d => x(d.start + d.events))
    .attr("y", barY + barHeight + 11)
    .attr("text-anchor", "middle")
    .text(d => formatShare(d.next));
}

// Only the title changes with the selection; the rest of the legend is fixed
function setLegendTitle(startYear, endYear) {
  d3.select("#legend .legend-title")
    .text(`Share of active events per Melbourne suburb, ${startYear}–${endYear}`);
}

// Other helpers
function addHeading(target, title, subtitle, titleClass = "") {
  const heading = target.append("g")
    .attr("class", "heading");

  heading.append("text")
    .attr("class", `title ${titleClass}`.trim())
    .attr("y", 21)
    .text(title);

  heading.append("text")
    .attr("class", "subtitle")
    .attr("y", 37)
    .text(subtitle);

  return heading;
}

// Main function
function main([geo, rows]) {
  // The suburb file has clockwise outer rings, as d3-geo expects.
  // In mapshaper.org, use the option `reverse-winding` when exporting to GeoJSON.
  const features = geo.features.filter(f => f.geometry);
  const collection = { type: "FeatureCollection", features };

  // Fit the map to the page column's width, then size the SVG to the drawing's height
  const width = Math.floor(svg.node().parentNode.getBoundingClientRect().width);
  const projection = d3.geoMercator().fitWidth(width, collection);
  const path = d3.geoPath(projection);
  const [, [, y1]] = path.bounds(collection);
  const height = Math.ceil(y1);
  svg.attr("width", width)
    .attr("height", height);

  const events = prepareEvents(rows, features);

  // From share of events to color: scaleThreshold puts x < threshold in the lower class (e.g. under 0.1%, first class)
  const color = d3.scaleThreshold()
    .domain(limits)
    .range(d3.schemeOranges[limits.length + 1]);

  const suburbs = drawMap(features, projection, path, width, height);
  setupZoom(suburbs, path, width, height);

  // Fixed legend, one scale, drawn once; bar proportions use all events (1900–2025).
  countEvents(events, features, -Infinity, Infinity);
  colourSuburbs(suburbs, color);
  drawLegend(color, features, width);

  // The line chart's selection window filters the map to the selected years.
  // The chart only counts events in a mapped suburb, so it matches the map.
  drawChart(events.filter(e => e.suburb >= 0), width, (startYear, endYear) => {
    countEvents(events, features, startYear, endYear);
    colourSuburbs(suburbs, color);
    setLegendTitle(startYear, endYear);
  });
}

// Also wait for the web font, so the annotation box is measured with it
Promise.all([
  d3.json(suburbsFile),
  d3.csv(eventsFile),
  document.fonts.ready
]).then(main);
