"use client";

import { useState } from "react";
import { useCRMStore } from "@/lib/store";
import { formatDate } from "@/lib/utils";
import {
  CloudLightning,
  Search,
  MapPin,
  Calendar,
  Wind,
  Droplets,
  AlertTriangle,
  CheckCircle,
  ExternalLink,
  Star,
} from "lucide-react";

export function StormLookup() {
  const { stormEvents } = useCRMStore();
  const [address, setAddress] = useState("");
  const [searchPerformed, setSearchPerformed] = useState(false);
  const [dateRange, setDateRange] = useState({ from: "2023-01-01", to: "2024-12-31" });
  const [filterType, setFilterType] = useState("all");

  const filteredEvents = stormEvents.filter((e) => {
    if (filterType !== "all" && e.type !== filterType) return false;
    return true;
  });

  const handleSearch = () => {
    setSearchPerformed(true);
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div>
        <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
          <CloudLightning className="h-6 w-6 text-purple-500" />
          Storm History Lookup
        </h2>
        <p className="text-sm text-gray-500 mt-1">
          Search for hail and wind events by property address to find the best date of loss for insurance claims.
          Data sourced from NOAA/NWS storm reports and HailTrace.
        </p>
      </div>

      {/* Search Form */}
      <div className="card card-body space-y-4">
        <div>
          <label className="label">Property Address</label>
          <div className="relative">
            <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Enter property address (e.g., 1234 Oak Street, Dallas, TX 75201)"
              className="input pl-10"
            />
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="label">From Date</label>
            <input type="date" value={dateRange.from} onChange={(e) => setDateRange({ ...dateRange, from: e.target.value })} className="input" />
          </div>
          <div>
            <label className="label">To Date</label>
            <input type="date" value={dateRange.to} onChange={(e) => setDateRange({ ...dateRange, to: e.target.value })} className="input" />
          </div>
          <div>
            <label className="label">Storm Type</label>
            <select value={filterType} onChange={(e) => setFilterType(e.target.value)} className="input">
              <option value="all">All Types</option>
              <option value="hail">Hail Only</option>
              <option value="wind">Wind Only</option>
              <option value="hail_and_wind">Hail & Wind</option>
            </select>
          </div>
        </div>
        <button onClick={handleSearch} className="btn-primary">
          <Search className="h-4 w-4" /> Search Storm History
        </button>
      </div>

      {/* Results */}
      {searchPerformed && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900">
              {filteredEvents.length} storm events found
            </h3>
            <p className="text-xs text-gray-500">Showing results within 5 miles of property</p>
          </div>

          {/* Recommendation Banner */}
          {filteredEvents.some((e) => e.recommended) && (
            <div className="rounded-lg bg-purple-50 border border-purple-200 p-4 flex items-start gap-3">
              <Star className="h-5 w-5 text-purple-600 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-purple-800">Recommended Date of Loss</p>
                <p className="text-sm text-purple-700 mt-1">
                  Based on severity and proximity, we recommend using{" "}
                  <strong>{formatDate(filteredEvents.find((e) => e.recommended)?.date || "")}</strong>{" "}
                  as the date of loss for insurance claims at this property.
                </p>
              </div>
            </div>
          )}

          {/* Storm Event Cards */}
          {filteredEvents.map((event) => (
            <div
              key={event.id}
              className={`card card-body ${event.recommended ? "ring-2 ring-purple-400" : ""}`}
            >
              <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                <div className="flex items-center gap-3">
                  <div className={`rounded-lg p-3 ${
                    event.type === "hail" ? "bg-violet-100" :
                    event.type === "wind" ? "bg-sky-100" :
                    event.type === "hail_and_wind" ? "bg-orange-100" :
                    "bg-gray-100"
                  }`}>
                    {event.type === "hail" || event.type === "hail_and_wind" ? (
                      <Droplets className={`h-6 w-6 ${event.type === "hail" ? "text-violet-600" : "text-orange-600"}`} />
                    ) : (
                      <Wind className="h-6 w-6 text-sky-600" />
                    )}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-bold text-gray-900 capitalize">
                        {event.type.replace("_", " & ")} Event
                      </p>
                      {event.recommended && (
                        <span className="badge bg-purple-100 text-purple-700">
                          <Star className="h-3 w-3 mr-1" /> Recommended
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      {new Date(event.date).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
                    </p>
                  </div>
                </div>

                <div className="flex-1 grid grid-cols-2 sm:grid-cols-4 gap-3 sm:ml-4">
                  {event.hailSize && (
                    <div>
                      <p className="text-[10px] uppercase text-gray-400">Hail Size</p>
                      <p className="text-sm font-bold text-violet-600">{event.hailSize}</p>
                    </div>
                  )}
                  {event.windSpeed && (
                    <div>
                      <p className="text-[10px] uppercase text-gray-400">Wind Speed</p>
                      <p className="text-sm font-bold text-sky-600">{event.windSpeed}</p>
                    </div>
                  )}
                  <div>
                    <p className="text-[10px] uppercase text-gray-400">Severity</p>
                    <span className={`badge ${
                      event.severity === "catastrophic" ? "bg-red-100 text-red-700" :
                      event.severity === "severe" ? "bg-orange-100 text-orange-700" :
                      event.severity === "moderate" ? "bg-yellow-100 text-yellow-700" :
                      "bg-gray-100 text-gray-600"
                    }`}>
                      {event.severity}
                    </span>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase text-gray-400">Location</p>
                    <p className="text-xs text-gray-600">{event.location}</p>
                  </div>
                </div>

                <button className="btn-secondary shrink-0">
                  Use as Date of Loss
                </button>
              </div>

              <div className="mt-3 pt-3 border-t border-gray-100 flex items-center gap-4 text-xs text-gray-400">
                <span>Source: {event.source}</span>
                <span>County: {event.county}, {event.state}</span>
              </div>
            </div>
          ))}

          {/* Data Sources Info */}
          <div className="card card-body">
            <h4 className="text-sm font-semibold text-gray-900 mb-3">Data Sources</h4>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="flex items-start gap-3 p-3 rounded-lg bg-gray-50">
                <CheckCircle className="h-5 w-5 text-green-500 shrink-0" />
                <div>
                  <p className="text-sm font-medium">NOAA/NWS Reports</p>
                  <p className="text-xs text-gray-500">Official National Weather Service storm reports</p>
                </div>
              </div>
              <div className="flex items-start gap-3 p-3 rounded-lg bg-gray-50">
                <CheckCircle className="h-5 w-5 text-green-500 shrink-0" />
                <div>
                  <p className="text-sm font-medium">HailTrace Integration</p>
                  <p className="text-xs text-gray-500">Address-level hail history going back 14+ years</p>
                </div>
              </div>
              <div className="flex items-start gap-3 p-3 rounded-lg bg-gray-50">
                <CheckCircle className="h-5 w-5 text-green-500 shrink-0" />
                <div>
                  <p className="text-sm font-medium">Local Storm Reports</p>
                  <p className="text-xs text-gray-500">Spotter reports and local verification data</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {!searchPerformed && (
        <div className="card card-body text-center py-16">
          <CloudLightning className="h-16 w-16 text-gray-300 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900">Search Storm History</h3>
          <p className="text-sm text-gray-500 mt-2 max-w-md mx-auto">
            Enter a property address to find documented hail and wind events.
            Results include severity, hail size, wind speed, and our recommendation for the best date of loss.
          </p>
        </div>
      )}
    </div>
  );
}
