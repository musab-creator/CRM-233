'use client';

import ManagerPage from '@/components/estimator/outputs/ManagerPage';
import AdminPricing from '@/components/estimator/outputs/AdminPricing';

export default function AdminPricingPage() {
  return <ManagerPage view="admin">{() => <AdminPricing />}</ManagerPage>;
}
