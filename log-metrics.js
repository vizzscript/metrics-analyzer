#!/usr/bin/env node
//CMD: ./log-metrics.js /home/ptspl03/Documents/PROD/Consumer/2025-05-16_clevertap.log --html
const fs = require('fs');
const readline = require('readline');
const path = require('path');

// Regex patterns
const timestampRegex = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/;
const logLevelRegex = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (\w+):/;
const jobCompletedRegex = /Job ID (\d+) completed successfully/;
const messageCompletedRegex = /wabaNumber (\d+) ::: (\d+) ::: Completed successfully with wamid: ([a-z0-9]+) ::: Clevertap MsgID: ([A-Z0-9-]+)/;
const storeSuccessRegex = /(\d+) ::: CleverTapStoreWamidMsgidService: ([a-z0-9]+) ::: ([A-Z0-9-]+) stored successfully/;
const cacheHitRegex = /Cache hit for wabaNumber: (\d+)/;
const errorRegex = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (error|warn):(.*)/i;

// Command line arguments handling
const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('Usage: ./log-metrics.js <logfile> [--output format]');
  console.error('Formats: json, html, console (default: all)');
  process.exit(1);
}

const logFile = args[0];
const outputFormat = args.includes('--output') ? args[args.indexOf('--output') + 1] : 'all';

// Metrics tracking
let metrics = {
  startTime: null,
  endTime: null,
  completedJobs: 0,
  cacheHits: 0,
  messagesSent: 0,
  storeOperations: 0,
  errors: [],
  warnings: [],
  logLevels: {},
  uniqueWabaNumbers: new Set(),
  messageIds: new Set(),
  wamids: new Set(),
  jobIds: new Set(),
  wabaMessageMap: {}, // Track messages per WABA
  timeIntervals: {}, // Track operations by minute
  processingTimes: [], // Track time between message send and storage
  messagesToStore: {} // Track messages waiting to be stored to calculate processing time
};

(async () => {
  try {
    const rl = readline.createInterface({
      input: fs.createReadStream(logFile),
      crlfDelay: Infinity,
    });

    // Process each line of the log file
    for await (const line of rl) {
      // Extract timestamp and log level
      const logLevelMatch = line.match(logLevelRegex);
      if (logLevelMatch) {
        const timestamp = logLevelMatch[1];
        const level = logLevelMatch[2].toLowerCase();
        
        // Track log levels
        metrics.logLevels[level] = (metrics.logLevels[level] || 0) + 1;
        
        // Update timestamp range
        const logTime = new Date(timestamp);
        if (!metrics.startTime || logTime < metrics.startTime) metrics.startTime = logTime;
        if (!metrics.endTime || logTime > metrics.endTime) metrics.endTime = logTime;
        
        // Track time intervals (by minute)
        const timeKey = timestamp.substring(0, 16); // YYYY-MM-DD HH:MM
        if (!metrics.timeIntervals[timeKey]) {
          metrics.timeIntervals[timeKey] = {
            messages: 0,
            cacheHits: 0,
            jobs: 0,
            stores: 0
          };
        }
        
        // Detect errors and warnings
        if (level === 'error') {
          metrics.errors.push({ timestamp, message: line });
        } else if (level === 'warn') {
          metrics.warnings.push({ timestamp, message: line });
        }
      }

      // Track completed jobs
      const jobMatch = line.match(jobCompletedRegex);
      if (jobMatch) {
        metrics.completedJobs++;
        metrics.jobIds.add(jobMatch[1]);
        
        // Update time interval metrics
        const timestampMatch = line.match(timestampRegex);
        if (timestampMatch) {
          const timeKey = timestampMatch[1].substring(0, 16);
          if (metrics.timeIntervals[timeKey]) {
            metrics.timeIntervals[timeKey].jobs++;
          }
        }
      }

      // Track messages sent
      const messageMatch = line.match(messageCompletedRegex);
      if (messageMatch) {
        const wabaNumber = messageMatch[1];
        const identifier = messageMatch[2];
        const wamid = messageMatch[3];
        const msgId = messageMatch[4];
        
        metrics.messagesSent++;
        metrics.uniqueWabaNumbers.add(wabaNumber);
        metrics.wamids.add(wamid);
        metrics.messageIds.add(msgId);
        
        // Track message per WABA
        if (!metrics.wabaMessageMap[wabaNumber]) {
          metrics.wabaMessageMap[wabaNumber] = {
            messageIds: new Set(),
            wamids: new Set(),
            count: 0
          };
        }
        metrics.wabaMessageMap[wabaNumber].messageIds.add(msgId);
        metrics.wabaMessageMap[wabaNumber].wamids.add(wamid);
        metrics.wabaMessageMap[wabaNumber].count++;
        
        // Track for processing time calculation
        metrics.messagesToStore[wamid] = {
          wabaNumber,
          msgId,
          sentTimestamp: line.match(timestampRegex)?.[1]
        };
        
        // Update time interval metrics
        const timestampMatch = line.match(timestampRegex);
        if (timestampMatch) {
          const timeKey = timestampMatch[1].substring(0, 16);
          if (metrics.timeIntervals[timeKey]) {
            metrics.timeIntervals[timeKey].messages++;
          }
        }
      }

      // Track store operations
      const storeMatch = line.match(storeSuccessRegex);
      if (storeMatch) {
        const wabaNumber = storeMatch[1];
        const wamid = storeMatch[2];
        const msgId = storeMatch[3];
        
        metrics.storeOperations++;
        
        // Calculate processing time if we have the original message
        if (metrics.messagesToStore[wamid]) {
          const sentTime = metrics.messagesToStore[wamid].sentTimestamp;
          const storeTime = line.match(timestampRegex)?.[1];
          
          if (sentTime && storeTime) {
            const processingTimeMs = new Date(storeTime) - new Date(sentTime);
            metrics.processingTimes.push({
              wamid,
              msgId,
              wabaNumber,
              processingTimeMs
            });
          }
          
          // Remove from tracking
          delete metrics.messagesToStore[wamid];
        }
        
        // Update time interval metrics
        const timestampMatch = line.match(timestampRegex);
        if (timestampMatch) {
          const timeKey = timestampMatch[1].substring(0, 16);
          if (metrics.timeIntervals[timeKey]) {
            metrics.timeIntervals[timeKey].stores++;
          }
        }
      }

      // Track cache hits
      const cacheMatch = line.match(cacheHitRegex);
      if (cacheMatch) {
        metrics.cacheHits++;
        metrics.uniqueWabaNumbers.add(cacheMatch[1]);
        
        // Update time interval metrics
        const timestampMatch = line.match(timestampRegex);
        if (timestampMatch) {
          const timeKey = timestampMatch[1].substring(0, 16);
          if (metrics.timeIntervals[timeKey]) {
            metrics.timeIntervals[timeKey].cacheHits++;
          }
        }
      }
    }

    // Calculate derived metrics
    const calculateMetrics = () => {
      if (!metrics.startTime || !metrics.endTime) {
        console.error('No valid timestamps found in log.');
        process.exit(1);
      }

      const durationMs = metrics.endTime - metrics.startTime;
      const durationSeconds = durationMs / 1000;
      
      // Calculate message processing times
      let totalProcessingTime = 0;
      let minProcessingTime = Number.MAX_SAFE_INTEGER;
      let maxProcessingTime = 0;
      
      metrics.processingTimes.forEach(item => {
        totalProcessingTime += item.processingTimeMs;
        minProcessingTime = Math.min(minProcessingTime, item.processingTimeMs);
        maxProcessingTime = Math.max(maxProcessingTime, item.processingTimeMs);
      });
      
      const avgProcessingTime = metrics.processingTimes.length > 0 ? 
        totalProcessingTime / metrics.processingTimes.length : 0;
      
      // Sort time intervals for trend analysis
      const sortedIntervals = Object.keys(metrics.timeIntervals).sort();
      
      // Calculate peak throughput
      let peakMessages = 0;
      let peakInterval = '';
      sortedIntervals.forEach(interval => {
        if (metrics.timeIntervals[interval].messages > peakMessages) {
          peakMessages = metrics.timeIntervals[interval].messages;
          peakInterval = interval;
        }
      });
      
      // Message success rate
      const successRate = metrics.messagesSent > 0 ? 
        (metrics.storeOperations / metrics.messagesSent) * 100 : 0;
      
      // Format metrics for output
      return {
        startTime: metrics.startTime.toISOString(),
        endTime: metrics.endTime.toISOString(),
        duration: {
          milliseconds: durationMs,
          seconds: durationSeconds.toFixed(2),
          minutes: (durationSeconds / 60).toFixed(2)
        },
        messages: {
          total: metrics.messagesSent,
          perSecond: (metrics.messagesSent / durationSeconds).toFixed(2),
          successRate: successRate.toFixed(2) + '%'
        },
        jobs: {
          total: metrics.completedJobs,
          unique: metrics.jobIds.size,
          perSecond: (metrics.completedJobs / durationSeconds).toFixed(2)
        },
        wabaNumbers: {
          list: Array.from(metrics.uniqueWabaNumbers),
          count: metrics.uniqueWabaNumbers.size,
          messageDistribution: Object.fromEntries(
            Object.entries(metrics.wabaMessageMap).map(([wabaNumber, data]) => [
              wabaNumber, 
              {
                messages: data.count,
                uniqueMessageIds: data.messageIds.size,
                uniqueWamids: data.wamids.size,
                percentOfTotal: ((data.count / metrics.messagesSent) * 100).toFixed(2) + '%'
              }
            ])
          )
        },
        cacheMetrics: {
          hits: metrics.cacheHits,
          hitsPerWabaNumber: (metrics.cacheHits / metrics.uniqueWabaNumbers.size).toFixed(2)
        },
        storeOperations: metrics.storeOperations,
        messageIds: {
          unique: metrics.messageIds.size,
          ratio: (metrics.messageIds.size / metrics.messagesSent).toFixed(4)
        },
        wamids: {
          unique: metrics.wamids.size,
          ratio: (metrics.wamids.size / metrics.messagesSent).toFixed(4)
        },
        processing: {
          avgTimeMs: avgProcessingTime.toFixed(2),
          minTimeMs: metrics.processingTimes.length ? minProcessingTime : 'N/A',
          maxTimeMs: metrics.processingTimes.length ? maxProcessingTime : 'N/A',
          measuredMessages: metrics.processingTimes.length
        },
        throughput: {
          peakMessagesPerMinute: peakMessages,
          peakInterval: peakInterval,
          intervals: sortedIntervals.map(interval => ({
            timeWindow: interval,
            messages: metrics.timeIntervals[interval].messages,
            cacheHits: metrics.timeIntervals[interval].cacheHits,
            jobs: metrics.timeIntervals[interval].jobs,
            stores: metrics.timeIntervals[interval].stores
          }))
        },
        logLevels: metrics.logLevels,
        errors: metrics.errors,
        warnings: metrics.warnings
      };
    };

    // Generate final metrics
    const finalMetrics = calculateMetrics();
    
    // Output based on format
    if (outputFormat === 'json' || outputFormat === 'all') {
      const outputFile = path.join(path.dirname(logFile), 'log-metrics.json');
      fs.writeFileSync(outputFile, JSON.stringify(finalMetrics, null, 2));
      console.log(`JSON metrics saved to: ${outputFile}`);
    }
    
    if (outputFormat === 'console' || outputFormat === 'all') {
      console.log('Log Metrics Summary:');
      console.log(`Duration: ${finalMetrics.duration.seconds}s (${finalMetrics.duration.minutes} min)`);
      console.log(`Messages: ${finalMetrics.messages.total} (${finalMetrics.messages.perSecond}/sec)`);
      console.log(`Success Rate: ${finalMetrics.messages.successRate}`);
      console.log(`Unique WABA Numbers: ${finalMetrics.wabaNumbers.count}`);
      console.log(`Cache Hits: ${finalMetrics.cacheMetrics.hits}`);
      console.log(`Completed Jobs: ${finalMetrics.jobs.total}`);
      console.log(`Average Processing Time: ${finalMetrics.processing.avgTimeMs}ms`);
      console.log(`Peak Throughput: ${finalMetrics.throughput.peakMessagesPerMinute} messages/min at ${finalMetrics.throughput.peakInterval}`);
      
      if (finalMetrics.errors.length) {
        console.log(`\nErrors detected: ${finalMetrics.errors.length}`);
      }
    }
    
    if (outputFormat === 'html' || outputFormat === 'all') {
      // Generate HTML report
      const htmlReport = generateHtmlReport(finalMetrics);
      const outputFile = path.join(path.dirname(logFile), 'log-metrics-report.html');
      fs.writeFileSync(outputFile, htmlReport);
      console.log(`HTML report generated at: ${outputFile}`);
    }
    
  } catch (err) {
    console.error('Error processing log file:', err);
    process.exit(1);
  }
})();

// Function to generate HTML report
function generateHtmlReport(metrics) {
  // Create throughput chart data
  const chartData = metrics.throughput.intervals.map(interval => ({
    time: interval.timeWindow,
    messages: interval.messages,
    stores: interval.stores,
    cacheHits: interval.cacheHits
  }));

  // Create WABA distribution data
  const wabaData = Object.entries(metrics.wabaNumbers.messageDistribution).map(([wabaNumber, data]) => ({
    wabaNumber,
    messages: data.messages,
    percent: parseFloat(data.percentOfTotal)
  }));

  return `<!DOCTYPE html>
<html>
<head>
  <title>WhatsApp Message Log Analysis</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; background-color: #f9f9f9; }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { color: #25D366; /* WhatsApp green */ }
    .metric-card { 
      background-color: white; 
      border-radius: 8px; 
      padding: 15px; 
      margin-bottom: 15px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 15px;
    }
    .metric-title { font-weight: bold; margin-bottom: 8px; color: #075E54; /* WhatsApp dark green */ }
    .metric-value { font-size: 1.2em; }
    .highlight { color: #128C7E; /* WhatsApp medium green */ }
    .error { color: #FF0000; }
    .warning { color: #FFA500; }
    .chart-container {
      height: 300px;
      margin-bottom: 20px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 20px;
    }
    th, td {
      padding: 8px;
      text-align: left;
      border-bottom: 1px solid #ddd;
    }
    th {
      background-color: #f2f2f2;
    }
    tr:hover {
      background-color: #f5f5f5;
    }
    .collapsible {
      background-color: #f2f2f2;
      color: #075E54;
      cursor: pointer;
      padding: 18px;
      width: 100%;
      border: none;
      text-align: left;
      outline: none;
      font-size: 15px;
      border-radius: 8px;
      margin-bottom: 5px;
    }
    .active, .collapsible:hover {
      background-color: #e6e6e6;
    }
    .content {
      padding: 0 18px;
      max-height: 0;
      overflow: hidden;
      transition: max-height 0.2s ease-out;
      background-color: #f9f9f9;
      border-radius: 0 0 8px 8px;
    }
  </style>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/3.9.1/chart.min.js"></script>
</head>
<body>
  <div class="container">
    <h1>WhatsApp Message Log Analysis</h1>
    
    <div class="metric-card">
      <div class="metric-title">Time Range & Overview</div>
      <div class="metric-value">From: ${new Date(metrics.startTime).toLocaleString()}</div>
      <div class="metric-value">To: ${new Date(metrics.endTime).toLocaleString()}</div>
      <div class="metric-value">Duration: ${metrics.duration.seconds}s (${metrics.duration.minutes} min)</div>
      <div class="metric-value">Success Rate: <span class="highlight">${metrics.messages.successRate}</span></div>
    </div>
    
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-title">Message Metrics</div>
        <div class="metric-value">Total Messages: <span class="highlight">${metrics.messages.total}</span></div>
        <div class="metric-value">Messages/Sec: <span class="highlight">${metrics.messages.perSecond}</span></div>
        <div class="metric-value">Unique WAMIDs: ${metrics.wamids.unique}</div>
        <div class="metric-value">Unique Message IDs: ${metrics.messageIds.unique}</div>
      </div>
      
      <div class="metric-card">
        <div class="metric-title">WABA Numbers</div>
        <div class="metric-value">Count: <span class="highlight">${metrics.wabaNumbers.count}</span></div>
      </div>
      
      <div class="metric-card">
        <div class="metric-title">Job Metrics</div>
        <div class="metric-value">Completed Jobs: ${metrics.jobs.total}</div>
        <div class="metric-value">Jobs/Second: ${metrics.jobs.perSecond}</div>
        <div class="metric-value">Unique Job IDs: ${metrics.jobs.unique}</div>
      </div>
      
      <div class="metric-card">
        <div class="metric-title">Cache Metrics</div>
        <div class="metric-value">Cache Hits: ${metrics.cacheMetrics.hits}</div>
        <div class="metric-value">Hits/WABA: ${metrics.cacheMetrics.hitsPerWabaNumber}</div>
      </div>
      
      <div class="metric-card">
        <div class="metric-title">Storage Operations</div>
        <div class="metric-value">Successful Stores: ${metrics.storeOperations}</div>
      </div>
      
      <div class="metric-card">
        <div class="metric-title">Processing Times</div>
        <div class="metric-value">Average: <span class="highlight">${metrics.processing.avgTimeMs}ms</span></div>
        <div class="metric-value">Min: ${metrics.processing.minTimeMs}ms</div>
        <div class="metric-value">Max: ${metrics.processing.maxTimeMs}ms</div>
        <div class="metric-value">Measured: ${metrics.processing.measuredMessages}</div>
      </div>
    </div>
    
    <div class="metric-card">
      <div class="metric-title">Message Throughput Over Time</div>
      <div class="chart-container">
        <canvas id="throughputChart"></canvas>
      </div>
    </div>
    
    <div class="metric-card">
      <div class="metric-title">WABA Number Distribution</div>
      <div class="chart-container">
        <canvas id="wabaDistributionChart"></canvas>
      </div>
    </div>
    
    <button class="collapsible">WABA Message Distribution Details</button>
    <div class="content">
      <table>
        <tr>
          <th>WABA Number</th>
          <th>Messages</th>
          <th>Unique Message IDs</th>
          <th>Unique WAMIDs</th>
          <th>% of Total</th>
        </tr>
        ${Object.entries(metrics.wabaNumbers.messageDistribution).map(([wabaNumber, data]) => `
          <tr>
            <td>${wabaNumber}</td>
            <td>${data.messages}</td>
            <td>${data.uniqueMessageIds}</td>
            <td>${data.uniqueWamids}</td>
            <td>${data.percentOfTotal}</td>
          </tr>
        `).join('')}
      </table>
    </div>
    
    <button class="collapsible">Throughput by Time Interval</button>
    <div class="content">
      <table>
        <tr>
          <th>Time Window</th>
          <th>Messages</th>
          <th>Store Operations</th>
          <th>Cache Hits</th>
          <th>Jobs</th>
        </tr>
        ${metrics.throughput.intervals.map(interval => `
          <tr>
            <td>${interval.timeWindow}</td>
            <td>${interval.messages}</td>
            <td>${interval.stores}</td>
            <td>${interval.cacheHits}</td>
            <td>${interval.jobs}</td>
          </tr>
        `).join('')}
      </table>
    </div>
    
    ${metrics.errors.length ? `
    <button class="collapsible error">Errors (${metrics.errors.length})</button>
    <div class="content">
      <table>
        <tr>
          <th>Timestamp</th>
          <th>Message</th>
        </tr>
        ${metrics.errors.map(error => `
          <tr>
            <td>${error.timestamp}</td>
            <td>${error.message}</td>
          </tr>
        `).join('')}
      </table>
    </div>
    ` : ''}
    
    ${metrics.warnings.length ? `
    <button class="collapsible warning">Warnings (${metrics.warnings.length})</button>
    <div class="content">
      <table>
        <tr>
          <th>Timestamp</th>
          <th>Message</th>
        </tr>
        ${metrics.warnings.map(warning => `
          <tr>
            <td>${warning.timestamp}</td>
            <td>${warning.message}</td>
          </tr>
        `).join('')}
      </table>
    </div>
    ` : ''}
    
  </div>
  
  <script>
    // Initialize charts
    window.onload = function() {
      // Throughput chart
      const ctxThroughput = document.getElementById('throughputChart').getContext('2d');
      new Chart(ctxThroughput, {
        type: 'line',
        data: {
          labels: ${JSON.stringify(chartData.map(item => item.time))},
          datasets: [
            {
              label: 'Messages',
              data: ${JSON.stringify(chartData.map(item => item.messages))},
              borderColor: '#25D366',
              backgroundColor: 'rgba(37, 211, 102, 0.1)',
              tension: 0.1
            },
            {
              label: 'Store Operations',
              data: ${JSON.stringify(chartData.map(item => item.stores))},
              borderColor: '#128C7E',
              backgroundColor: 'rgba(18, 140, 126, 0.1)',
              tension: 0.1
            },
            {
              label: 'Cache Hits',
              data: ${JSON.stringify(chartData.map(item => item.cacheHits))},
              borderColor: '#075E54',
              backgroundColor: 'rgba(7, 94, 84, 0.1)',
              tension: 0.1
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            y: {
              beginAtZero: true
            }
          }
        }
      });
      
      // WABA Distribution chart
      const ctxWaba = document.getElementById('wabaDistributionChart').getContext('2d');
      new Chart(ctxWaba, {
        type: 'pie',
        data: {
          labels: ${JSON.stringify(wabaData.map(item => item.wabaNumber))},
          datasets: [{
            data: ${JSON.stringify(wabaData.map(item => item.messages))},
            backgroundColor: [
              '#25D366', '#128C7E', '#075E54', '#34B7F1', '#5BC0DE', '#4BC0C0',
              '#36A2EB', '#9966FF', '#FF9F40', '#FF6384'
            ]
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: 'right'
            },
            tooltip: {
              callbacks: {
                label: function(context) {
                  const label = context.label || '';
                  const value = context.raw || 0;
                  const percentage = wabaData[context.dataIndex].percent;
                  return label + ': ' + value + ' (' + percentage + '%)';
                }
              }
            }
          }
        }
      });
      
      // Setup collapsible sections
      const coll = document.getElementsByClassName("collapsible");
      for (let i = 0; i < coll.length; i++) {
        coll[i].addEventListener("click", function() {
          this.classList.toggle("active");
          const content = this.nextElementSibling;
          if (content.style.maxHeight) {
            content.style.maxHeight = null;
          } else {
            content.style.maxHeight = content.scrollHeight + "px";
          }
        });
      }
    };
  </script>
</body>
</html>`;
}
