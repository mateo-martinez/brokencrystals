import { Injectable, Logger } from '@nestjs/common';
import { HttpClientService } from '../httpclient/httpclient.service';
import { ChatMessage } from './api/ChatMessage';
import { EntityManager, EntityRepository } from '@mikro-orm/core';


const DEFAULT_CHAT_API_MAX_TOKENS = 1000;

interface ChatRequest {
  readonly model: string;
  readonly messages: ChatMessage[];
  readonly stream: boolean;
  readonly max_tokens?: number;
  readonly temperature?: number;
}

interface ChatResponse {
  readonly choices: {
    readonly message: ChatMessage;
  }[];
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly httpClient: HttpClientService,
  ) {}

  private async query(messages: ChatMessage[]): Promise<string> {
    this.logger.debug(`Chat query: ${JSON.stringify(messages)}`);
    if (
      !process.env.CHAT_API_URL ||
      !process.env.CHAT_API_MODEL ||
      !process.env.CHAT_API_TOKEN
    ) {
      throw new Error(
        'Chat API environment variables are missing. CHAT_API_URL, CHAT_API_MODEL, CHAT_API_TOKEN are mandatory.'
      );
    }

    const chatRequest: ChatRequest = {
      model: process.env.CHAT_API_MODEL,
      messages,
      max_tokens:
        +process.env.CHAT_API_MAX_TOKENS || DEFAULT_CHAT_API_MAX_TOKENS,
      stream: false,
    };

    const res = await this.httpClient.post<ChatResponse>(
      process.env.CHAT_API_URL,
      chatRequest,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.CHAT_API_TOKEN}`,
        },
      }
    );

    return res?.choices?.[0]?.message?.content;
  }

  async processUserRequest(
    userMessage: string,
    userId: string
  ): Promise<string> {
    try {
      // Step 1: Classify the user message
      const classificationResponse = await this.query([
        {
          role: 'system',
          content: `
            You are an assistant for a crystal catalog and management app.
      
            Classify the user's message into one of four categories:
            1. "action": If the message is a request for a database action or query. Examples include creating testimonials or taking account actions.
            2. "retrieve": If the message involves searching for crystals or products.
            3. "general": If the message is a general question or prompt about crystals, or related to breaking bad, or introductory messages like "hello" or "what can you help me with".
            4. "irrelevant": If the message is unrelated to crystals or supported actions.
      
            Respond only with the classification: "action", "retrieve", "general", or "irrelevant".
          `,
          userId: ''
        },
        { role: 'user', content: userMessage, userId },
      ]);
      
  
      this.logger.debug(`Classification Result: ${classificationResponse}`);
   
      if (classificationResponse.trim() === 'action') {
        const aiResponse = await this.query([
          {
            role: 'system',
            content: `
              You are a helpful assistant that generates SQL Queries. The schema includes these entities:
      
              create table "user" ("id" serial primary key, "created_at" timestamptz(0) not null, "updated_at" timestamptz(0) not null, "email" varchar(255) not null, "password" varchar(255) not null, "first_name" varchar(255) not null, "last_name" varchar(255) not null, "is_admin" bool not null, "photo" bytea null, "company" varchar(255) not null, "card_number" varchar(255) not null, "phone_number" varchar(255) not null, "is_basic" bool not null);
      
              create table "testimonial" ("id" serial primary key, "created_at" timestamptz(0) not null, "updated_at" timestamptz(0) not null, "name" varchar(255) not null, "title" varchar(255) not null, "message" varchar(255) not null);
      
              The user's id is ${userId}
              Generate SQL commands for actions like creating a testimonial or updating a user record. 
              Output only the SQL query as plain text without any formatting, explanations, or additional characters (e.g., no backticks, no markdown, no code comments). Your response should be a valid SQL query ready for execution.
            `,
            userId: ''
          },
          { role: 'user', content: userMessage, userId },
        ]);
      
        this.logger.debug(`Generated Action Query: ${aiResponse}`);
      
        try {
          await this.em.getConnection().execute(aiResponse);
          return `Your request has been processed successfully.`;
        } catch (err) {
          this.logger.error(`Error executing action query: ${err.message}`);
          return `An error occurred while processing your request.`;
        }
      }
      
else if (classificationResponse.trim() === 'retrieve') {
  const aiResponse = await this.query([
    {
      role: 'system',
      content: `
        You are a helpful assistant that generates SQL queries. The schema includes the following entity:

        create table "product" (
          "id" serial primary key,
          "created_at" timestamptz(0) not null default now(),
          "category" varchar(255) not null,
          "photo_url" varchar(255) not null,
          "name" varchar(255) not null,
          "description" varchar(255) null,
          "views_count" int DEFAULT 0
        );

        Generate a SELECT query to retrieve the \`name\`, \`description\`, and \`photo_url\` of products where any of the identified keywords from the user's input match either the \`category\` or \`description\` fields. 

        1. Extract keywords from the user input that are relevant to the query.
        2. Use \`ILIKE\` conditions to match any of these keywords against the \`category\` or \`description\` fields.
        3. Combine the conditions using \`OR\` to ensure a match for any keyword.

        Output only the SQL query as plain text without any formatting, explanations, or additional characters (e.g., no backticks, no markdown, no code comments). Your response should be a valid SQL query ready for execution.
      `,
      userId: ''
    },
    { role: 'user', content: userMessage, userId },
  ]);

  this.logger.debug(`Generated SELECT Query: ${aiResponse}`);

  try {
    const queryResult = await this.em.getConnection().execute(aiResponse);

    if (!queryResult || queryResult.length === 0) {
      return '<p>No matching products found.</p>';
    }

    const response = queryResult
      .map(
        (item: { name: string; description: string; photo_url: string }) => `
          <div style="margin-bottom: 15px;">
            <h3 style="margin: 0;">${item.name}</h3>
            <p style="margin: 5px 0;">${item.description}</p>
            <img src="${item.photo_url}" alt="${item.name}" style="max-width: 200px; max-height: 200px;"/>
          </div>
        `
      )
      .join('');

    return `<div>${response}</div>`;
  } catch (err) {
    this.logger.error(`Error executing SELECT query: ${err.message}`);
    return `<p>An error occurred while retrieving products.</p>`;
  }
}        
       else if (classificationResponse.trim() === 'general') {
        const aiResponse = await this.query([
          {
            role: 'system',
            content: `
              You are a knowledgeable assistant specializing in crystals. 
              Respond to the user message with concise, engaging, and informative answers about crystals. Keep the response relevant and simple.
            `,
            userId: ''
          },
          { role: 'user', content: userMessage, userId },
        ]);
      
        this.logger.debug(`General Response: ${aiResponse}`);
        return `${aiResponse}`;
      }
       else {
        // Step 4: Irrelevant message
        return "I'm sorry, but I can only assist with queries or information related to crystals, testimonials or user account management.";
      }
    } catch (error) {
      this.logger.error(`Error processing user request: ${error.message}`);
      return `I apologize, but I couldn't process your request due to an error.`;
    }
  }
  
}
