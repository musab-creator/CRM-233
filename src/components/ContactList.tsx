"use client";

import { useState } from "react";
import { useCRMStore } from "@/lib/store";
import { formatDate, getSourceName, generateId } from "@/lib/utils";
import {
  Search,
  Plus,
  Phone,
  Mail,
  MapPin,
  Tag,
  Filter,
  Download,
  ChevronRight,
  X,
} from "lucide-react";

export function ContactList() {
  const { contacts, addContact, setSelectedContactId, setCurrentView } = useCRMStore();
  const [searchTerm, setSearchTerm] = useState("");
  const [filterSource, setFilterSource] = useState("all");
  const [showAddModal, setShowAddModal] = useState(false);
  const [newContact, setNewContact] = useState({
    firstName: "", lastName: "", email: "", phone: "",
    address: "", city: "", state: "", zip: "",
    insuranceCompany: "", policyNumber: "",
    source: "door_knock" as const,
    notes: "",
  });

  const filtered = contacts.filter((c) => {
    const term = searchTerm.toLowerCase();
    const matchesSearch = !searchTerm ||
      `${c.firstName} ${c.lastName}`.toLowerCase().includes(term) ||
      c.email.toLowerCase().includes(term) ||
      c.phone.includes(term) ||
      c.address.toLowerCase().includes(term);
    const matchesSource = filterSource === "all" || c.source === filterSource;
    return matchesSearch && matchesSource;
  });

  const handleAdd = () => {
    addContact({
      ...newContact,
      id: generateId(),
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    setShowAddModal(false);
    setNewContact({
      firstName: "", lastName: "", email: "", phone: "",
      address: "", city: "", state: "", zip: "",
      insuranceCompany: "", policyNumber: "",
      source: "door_knock", notes: "",
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Contacts & Homeowners</h2>
          <p className="text-sm text-gray-500">{contacts.length} total contacts</p>
        </div>
        <div className="flex gap-2">
          <button className="btn-secondary"><Download className="h-4 w-4" /> Export</button>
          <button onClick={() => setShowAddModal(true)} className="btn-primary">
            <Plus className="h-4 w-4" /> Add Contact
          </button>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search contacts..."
            className="input pl-10"
          />
        </div>
        <select value={filterSource} onChange={(e) => setFilterSource(e.target.value)} className="input w-auto">
          <option value="all">All Sources</option>
          <option value="door_knock">Door Knock</option>
          <option value="referral">Referral</option>
          <option value="website">Website</option>
          <option value="storm_chase">Storm Chase</option>
          <option value="google_ads">Google Ads</option>
          <option value="facebook_ads">Facebook Ads</option>
          <option value="yard_sign">Yard Sign</option>
        </select>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-100">
              <th className="table-header px-6 py-3">Name</th>
              <th className="table-header px-6 py-3">Contact</th>
              <th className="table-header px-6 py-3">Address</th>
              <th className="table-header px-6 py-3">Insurance</th>
              <th className="table-header px-6 py-3">Source</th>
              <th className="table-header px-6 py-3">Tags</th>
              <th className="table-header px-6 py-3">Added</th>
              <th className="table-header px-6 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {filtered.map((contact) => (
              <tr key={contact.id} className="hover:bg-gray-50">
                <td className="table-cell">
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-600">
                      {contact.firstName[0]}{contact.lastName[0]}
                    </div>
                    <div>
                      <p className="font-medium text-gray-900">{contact.firstName} {contact.lastName}</p>
                    </div>
                  </div>
                </td>
                <td className="table-cell">
                  <div className="space-y-1">
                    <p className="flex items-center gap-1 text-xs"><Mail className="h-3 w-3" />{contact.email}</p>
                    <p className="flex items-center gap-1 text-xs"><Phone className="h-3 w-3" />{contact.phone}</p>
                  </div>
                </td>
                <td className="table-cell">
                  <p className="flex items-center gap-1 text-xs">
                    <MapPin className="h-3 w-3 shrink-0" />
                    <span className="truncate max-w-[200px]">{contact.address}, {contact.city}</span>
                  </p>
                </td>
                <td className="table-cell">
                  {contact.insuranceCompany ? (
                    <div>
                      <p className="text-sm font-medium">{contact.insuranceCompany}</p>
                      <p className="text-xs text-gray-500">{contact.policyNumber}</p>
                    </div>
                  ) : (
                    <span className="text-xs text-gray-400">N/A</span>
                  )}
                </td>
                <td className="table-cell">
                  <span className="badge bg-gray-100 text-gray-600">{getSourceName(contact.source)}</span>
                </td>
                <td className="table-cell">
                  <div className="flex flex-wrap gap-1">
                    {contact.tags.slice(0, 2).map((tag) => (
                      <span key={tag} className="badge bg-brand-50 text-brand-600 text-[10px]">{tag}</span>
                    ))}
                    {contact.tags.length > 2 && (
                      <span className="badge bg-gray-50 text-gray-500 text-[10px]">+{contact.tags.length - 2}</span>
                    )}
                  </div>
                </td>
                <td className="table-cell text-gray-500 text-xs">{formatDate(contact.createdAt)}</td>
                <td className="table-cell">
                  <button className="p-1 rounded hover:bg-gray-100">
                    <ChevronRight className="h-4 w-4 text-gray-400" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Add Contact Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white shadow-xl max-h-[90vh] overflow-y-auto">
            <div className="sticky top-0 bg-white border-b border-gray-100 px-6 py-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold">Add New Contact</h3>
              <button onClick={() => setShowAddModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="px-6 py-4 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">First Name *</label>
                  <input value={newContact.firstName} onChange={(e) => setNewContact({...newContact, firstName: e.target.value})} className="input" />
                </div>
                <div>
                  <label className="label">Last Name *</label>
                  <input value={newContact.lastName} onChange={(e) => setNewContact({...newContact, lastName: e.target.value})} className="input" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">Email</label>
                  <input type="email" value={newContact.email} onChange={(e) => setNewContact({...newContact, email: e.target.value})} className="input" />
                </div>
                <div>
                  <label className="label">Phone *</label>
                  <input value={newContact.phone} onChange={(e) => setNewContact({...newContact, phone: e.target.value})} className="input" />
                </div>
              </div>
              <div>
                <label className="label">Street Address</label>
                <input value={newContact.address} onChange={(e) => setNewContact({...newContact, address: e.target.value})} className="input" />
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="label">City</label>
                  <input value={newContact.city} onChange={(e) => setNewContact({...newContact, city: e.target.value})} className="input" />
                </div>
                <div>
                  <label className="label">State</label>
                  <input value={newContact.state} onChange={(e) => setNewContact({...newContact, state: e.target.value})} className="input" />
                </div>
                <div>
                  <label className="label">ZIP</label>
                  <input value={newContact.zip} onChange={(e) => setNewContact({...newContact, zip: e.target.value})} className="input" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">Insurance Company</label>
                  <input value={newContact.insuranceCompany} onChange={(e) => setNewContact({...newContact, insuranceCompany: e.target.value})} className="input" />
                </div>
                <div>
                  <label className="label">Policy Number</label>
                  <input value={newContact.policyNumber} onChange={(e) => setNewContact({...newContact, policyNumber: e.target.value})} className="input" />
                </div>
              </div>
              <div>
                <label className="label">Lead Source</label>
                <select value={newContact.source} onChange={(e) => setNewContact({...newContact, source: e.target.value as any})} className="input">
                  <option value="door_knock">Door Knock</option>
                  <option value="referral">Referral</option>
                  <option value="website">Website</option>
                  <option value="storm_chase">Storm Chase</option>
                  <option value="google_ads">Google Ads</option>
                  <option value="facebook_ads">Facebook Ads</option>
                  <option value="yard_sign">Yard Sign</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div>
                <label className="label">Notes</label>
                <textarea value={newContact.notes} onChange={(e) => setNewContact({...newContact, notes: e.target.value})} className="input" rows={3} />
              </div>
            </div>
            <div className="sticky bottom-0 bg-white border-t border-gray-100 px-6 py-4 flex justify-end gap-3">
              <button onClick={() => setShowAddModal(false)} className="btn-secondary">Cancel</button>
              <button
                onClick={handleAdd}
                disabled={!newContact.firstName || !newContact.lastName}
                className="btn-primary"
              >
                Add Contact
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
