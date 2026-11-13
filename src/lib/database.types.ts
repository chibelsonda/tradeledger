export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type OrganizationRole =
  | 'owner'
  | 'admin'
  | 'accountant'
  | 'member'
  | 'subcontractor'

export type ProjectStatus = 'active' | 'on_hold' | 'completed' | 'archived'
export type SubcontractorStatus = 'active' | 'inactive' | 'blocked'
export type PaymentRequestStatus =
  | 'draft'
  | 'submitted'
  | 'approved'
  | 'checkout_created'
  | 'processing'
  | 'paid'
  | 'failed'
  | 'canceled'
export type PaymentStatus =
  | 'pending'
  | 'processing'
  | 'paid'
  | 'failed'
  | 'expired'

export type Organization = {
  id: string
  name: string
  slug: string
  created_by: string
  created_at: string
  updated_at: string
}

export type OrganizationMembership = {
  organization_id: string
  user_id: string
  role: OrganizationRole
  status: 'invited' | 'active' | 'suspended'
  created_at: string
  updated_at: string
}

export type Project = {
  id: string
  organization_id: string
  name: string
  code: string
  status: ProjectStatus
  created_by: string
  created_at: string
  updated_at: string
}

export type Subcontractor = {
  id: string
  organization_id: string
  user_id: string | null
  company_name: string
  contact_name: string | null
  email: string | null
  status: SubcontractorStatus
  created_by: string
  created_at: string
  updated_at: string
}

export type ProjectSubcontractor = {
  organization_id: string
  project_id: string
  subcontractor_id: string
  assigned_by: string
  assigned_at: string
}

export type PaymentRequest = {
  id: string
  organization_id: string
  project_id: string
  subcontractor_id: string
  created_by: string
  approved_by: string | null
  description: string
  gross_amount: number
  retainage_basis_points: number
  retainage_amount: number
  net_amount: number
  currency: string
  status: PaymentRequestStatus
  submitted_at: string | null
  approved_at: string | null
  checkout_started_at: string | null
  paid_at: string | null
  failed_at: string | null
  created_at: string
  updated_at: string
}

export type AuditEvent = {
  id: number
  organization_id: string
  actor_user_id: string | null
  action: string
  entity_type: string
  entity_id: string | null
  metadata: Json
  created_at: string
}

export type Payment = {
  id: number
  user_id: string | null
  organization_id: string | null
  payment_request_id: string | null
  reference: string
  product_name: string
  unit_amount: number
  quantity: number
  amount_total: number
  currency: string
  status: PaymentStatus
  stripe_checkout_session_id: string | null
  stripe_payment_intent_id: string | null
  customer_email: string | null
  paid_at: string | null
  created_at: string
  updated_at: string
}

export interface Database {
  public: {
    Tables: {
      organizations: {
        Row: Organization
        Insert: {
          id?: string
          name: string
          slug: string
          created_by: string
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Organization>
        Relationships: []
      }
      organization_memberships: {
        Row: OrganizationMembership
        Insert: OrganizationMembership
        Update: Partial<OrganizationMembership>
        Relationships: []
      }
      projects: {
        Row: Project
        Insert: {
          id?: string
          organization_id: string
          name: string
          code: string
          status?: ProjectStatus
          created_by?: string
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Project>
        Relationships: []
      }
      subcontractors: {
        Row: Subcontractor
        Insert: {
          id?: string
          organization_id: string
          user_id?: string | null
          company_name: string
          contact_name?: string | null
          email?: string | null
          status?: SubcontractorStatus
          created_by?: string
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Subcontractor>
        Relationships: []
      }
      project_subcontractors: {
        Row: ProjectSubcontractor
        Insert: {
          organization_id: string
          project_id: string
          subcontractor_id: string
          assigned_by?: string
          assigned_at?: string
        }
        Update: never
        Relationships: []
      }
      payment_requests: {
        Row: PaymentRequest
        Insert: Record<string, never>
        Update: Record<string, never>
        Relationships: []
      }
      audit_events: {
        Row: AuditEvent
        Insert: Record<string, never>
        Update: Record<string, never>
        Relationships: []
      }
      payments: {
        Row: Payment
        Insert: Omit<Payment, 'id' | 'created_at' | 'updated_at'> & {
          id?: number
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Payment>
        Relationships: []
      }
      stripe_webhook_events: {
        Row: {
          id: number
          event_id: string
          type: string
          processed_at: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: number
          event_id: string
          type: string
          processed_at?: string
          created_at?: string
          updated_at?: string
        }
        Update: Record<string, never>
        Relationships: []
      }
    }
    Views: Record<string, never>
    Functions: {
      organization_role: {
        Args: { p_organization_id: string }
        Returns: OrganizationRole | null
      }
      is_organization_member: {
        Args: { p_organization_id: string }
        Returns: boolean
      }
      has_organization_role: {
        Args: { p_organization_id: string; p_roles: string[] }
        Returns: boolean
      }
      create_organization: {
        Args: { p_name: string; p_slug: string }
        Returns: string
      }
      create_payment_request: {
        Args: {
          p_organization_id: string
          p_project_id: string
          p_subcontractor_id: string
          p_description: string
          p_gross_amount: number
          p_retainage_basis_points: number
          p_currency: string
        }
        Returns: string
      }
      submit_payment_request: {
        Args: { p_payment_request_id: string }
        Returns: boolean
      }
      approve_payment_request: {
        Args: { p_payment_request_id: string }
        Returns: boolean
      }
      transition_payment_request_status: {
        Args: {
          p_payment_request_id: string
          p_next_status: string
          p_actor_user_id?: string | null
          p_metadata?: Json
        }
        Returns: boolean
      }
      prepare_payment_request_checkout: {
        Args: {
          p_payment_request_id: string
          p_user_id: string
          p_reference: string
        }
        Returns: {
          payment_id: number
          payment_reference: string
          organization_id: string
          payment_request_id: string
          request_description: string
          project_name: string
          subcontractor_name: string
          amount_total: number
          currency: string
          customer_email: string | null
          stripe_checkout_session_id: string | null
        }[]
      }
      attach_payment_checkout_session: {
        Args: { p_reference: string; p_session_id: string }
        Returns: boolean
      }
      mark_payment_checkout_failed: {
        Args: { p_reference: string; p_reason?: string }
        Returns: boolean
      }
      process_stripe_webhook: {
        Args: {
          p_event_id: string
          p_event_type: string
          p_session_id: string | null
          p_payment_status: string | null
          p_payment_intent_id: string | null
          p_customer_email: string | null
        }
        Returns: boolean
      }
    }
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
